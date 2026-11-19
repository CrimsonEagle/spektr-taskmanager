use crate::gpu::GpuCollector;
use crate::models::{
    BatteryMetrics, BlameProcess, CpuMetrics, DiskDriveInfo, DiskMetrics, HistoryPoint,
    MemoryMetrics, NetworkInterfaceInfo, NetworkMetrics, ProcessEntry, SystemSummary,
    TelemetrySnapshot,
};
use crate::network;
use crate::process_ops;
use crate::win_cpu::WinCpuSampler;
use chrono::Utc;
use std::collections::{HashMap, HashSet, VecDeque};
use sysinfo::{Components, Disks, Networks, ProcessesToUpdate, System};

const MAX_HISTORY_POINTS: usize = 900; // 15 minutes at 1s interval
const MAX_SPARKLINE_POINTS: usize = 30;

pub struct TelemetryEngine {
    sys: System,
    disks: Disks,
    networks: Networks,
    components: Components,
    gpu: GpuCollector,
    win_cpu: WinCpuSampler,
    history: VecDeque<HistoryPoint>,
    proc_cpu_history: HashMap<u32, VecDeque<f32>>,
    suspended_pids: HashSet<u32>,
    efficiency_pids: HashSet<u32>,
    active_profile: String,
    last_listening_ports: usize,
    tick_count: u64,
}

impl TelemetryEngine {
    pub fn new() -> Self {
        let mut sys = System::new_all();
        sys.refresh_all();
        let disks = Disks::new_with_refreshed_list();
        let networks = Networks::new_with_refreshed_list();
        let components = Components::new_with_refreshed_list();
        let gpu = GpuCollector::new();
        let win_cpu = WinCpuSampler::new();

        Self {
            sys,
            disks,
            networks,
            components,
            gpu,
            win_cpu,
            history: VecDeque::with_capacity(MAX_HISTORY_POINTS + 1),
            proc_cpu_history: HashMap::new(),
            suspended_pids: HashSet::new(),
            efficiency_pids: HashSet::new(),
            active_profile: "normal".to_string(),
            last_listening_ports: 0,
            tick_count: 0,
        }
    }

    pub fn set_suspended_flag(&mut self, pid: u32, suspended: bool) {
        if suspended {
            self.suspended_pids.insert(pid);
        } else {
            self.suspended_pids.remove(&pid);
        }
    }

    pub fn set_efficiency_flag(&mut self, pid: u32, enabled: bool) {
        if enabled {
            self.efficiency_pids.insert(pid);
        } else {
            self.efficiency_pids.remove(&pid);
        }
    }

    pub fn set_active_profile(&mut self, profile: String) {
        self.active_profile = profile;
    }

    pub fn history(&self) -> Vec<HistoryPoint> {
        self.history.iter().cloned().collect()
    }

    pub fn process_lookup(&self) -> HashMap<u32, (String, String, String)> {
        let mut map = HashMap::new();
        for (pid, proc_) in self.sys.processes() {
            let name = proc_.name().to_string_lossy().to_string();
            let exe = proc_
                .exe()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let cmd = join_cmd(proc_.cmd());
            let category = classify_process(&name, &exe, &cmd);
            let subtitle = extract_subtitle(&name, &cmd, &exe);
            map.insert(pid.as_u32(), (name, subtitle, category));
        }
        map
    }

    pub fn process_name_map(&self) -> HashMap<u32, String> {
        self.sys
            .processes()
            .iter()
            .map(|(pid, p)| (pid.as_u32(), p.name().to_string_lossy().to_string()))
            .collect()
    }

    pub fn parent_map(&self) -> HashMap<u32, Option<u32>> {
        self.sys
            .processes()
            .iter()
            .map(|(pid, p)| (pid.as_u32(), p.parent().map(|pp| pp.as_u32())))
            .collect()
    }

    pub fn collect(&mut self) -> TelemetrySnapshot {
        self.tick_count += 1;

        self.sys.refresh_cpu_all();
        self.sys.refresh_memory();
        self.sys
            .refresh_processes(ProcessesToUpdate::All, true);
        let win_snap = self.win_cpu.sample();
        self.networks.refresh(true);

        if self.tick_count % 5 == 1 {
            self.disks.refresh(true);
            self.components.refresh(true);
        }

        let gpu_metrics = self.gpu.refresh();

        let cpus = self.sys.cpus();
        let logical_cores = cpus.len().max(1);
        let physical_cores = self.sys.physical_core_count().unwrap_or(logical_cores);
        let total_cpu = win_snap
            .total_cpu_percent
            .unwrap_or_else(|| self.sys.global_cpu_usage())
            .clamp(0.0, 100.0);
        let per_core: Vec<f32> = cpus
            .iter()
            .map(|c| c.cpu_usage().clamp(0.0, 100.0))
            .collect();
        let brand = cpus
            .first()
            .map(|c| c.brand().trim().to_string())
            .unwrap_or_else(|| "CPU".to_string());
        let frequency_mhz = cpus.first().map(|c| c.frequency()).unwrap_or(0);

        let cpu_temp = self
            .components
            .iter()
            .find(|c| {
                let l = c.label().to_lowercase();
                l.contains("cpu") || l.contains("package") || l.contains("core")
            })
            .and_then(|c| c.temperature());

        let cpu_metrics = CpuMetrics {
            total_usage: total_cpu,
            per_core,
            brand,
            frequency_mhz,
            physical_cores,
            logical_cores,
            temperature_c: cpu_temp,
        };

        // Memory
        let total_mem = self.sys.total_memory();
        let used_mem = self.sys.used_memory();
        let avail_mem = self.sys.available_memory();
        let cached_mem = total_mem.saturating_sub(used_mem).min(avail_mem / 2);
        let ram_percent = if total_mem > 0 {
            ((used_mem as f64 / total_mem as f64) * 100.0) as f32
        } else {
            0.0
        };

        let memory_metrics = MemoryMetrics {
            used_bytes: used_mem,
            total_bytes: total_mem,
            available_bytes: avail_mem,
            cached_bytes: cached_mem,
            usage_percent: ram_percent.clamp(0.0, 100.0),
            swap_used_bytes: self.sys.used_swap(),
            swap_total_bytes: self.sys.total_swap(),
        };

        // Processes + aggregate disk I/O
        let mut total_disk_read: u64 = 0;
        let mut total_disk_write: u64 = 0;
        let mut active_pids = HashSet::new();
        let mut processes = Vec::with_capacity(self.sys.processes().len());

        for (pid, proc_) in self.sys.processes() {
            let pid_u32 = pid.as_u32();
            active_pids.insert(pid_u32);

            let name = proc_.name().to_string_lossy().to_string();
            let exe_path = proc_
                .exe()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let cmd_line = join_cmd(proc_.cmd());
            let category = classify_process(&name, &exe_path, &cmd_line);
            let subtitle = extract_subtitle(&name, &cmd_line, &exe_path);
            let group_key = compute_group_key(&name);

            let win_info = win_snap.per_pid.get(&pid_u32);
            let cpu_percent = win_info
                .map(|w| w.cpu_percent)
                .unwrap_or_else(|| (proc_.cpu_usage() / logical_cores as f32).clamp(0.0, 100.0));
            let mem_bytes = proc_.memory();
            let disk = proc_.disk_usage();
            total_disk_read = total_disk_read.saturating_add(disk.read_bytes);
            total_disk_write = total_disk_write.saturating_add(disk.written_bytes);

            // Sparkline ring buffer per PID
            let hist = self
                .proc_cpu_history
                .entry(pid_u32)
                .or_insert_with(|| VecDeque::with_capacity(MAX_SPARKLINE_POINTS));
            if hist.len() >= MAX_SPARKLINE_POINTS {
                hist.pop_front();
            }
            hist.push_back((cpu_percent * 10.0).round() / 10.0);

            let handle_count = win_info
                .map(|w| w.handle_count)
                .or_else(|| process_ops::get_process_handle_count(pid_u32));
            let thread_count = win_info.map(|w| w.thread_count);

            let is_suspended = self.suspended_pids.contains(&pid_u32);
            let is_efficiency_mode = self.efficiency_pids.contains(&pid_u32);
            let status_str = if is_suspended {
                "Eingefroren".to_string()
            } else {
                format!("{:?}", proc_.status())
            };

            processes.push(ProcessEntry {
                pid: pid_u32,
                parent_pid: proc_.parent().map(|p| p.as_u32()),
                name,
                group_key,
                subtitle,
                category,
                cpu_percent: (cpu_percent * 10.0).round() / 10.0,
                memory_bytes: mem_bytes,
                disk_read_bytes_per_sec: disk.read_bytes,
                disk_write_bytes_per_sec: disk.written_bytes,
                total_disk_read_bytes: disk.total_read_bytes,
                total_disk_write_bytes: disk.total_written_bytes,
                status: status_str,
                is_suspended,
                is_efficiency_mode,
                run_time_seconds: proc_.run_time(),
                exe_path,
                cmd_line,
                handle_count,
                thread_count,
                cpu_history: hist.iter().copied().collect(),
            });
        }

        // Cleanup exited PIDs from caches
        self.proc_cpu_history.retain(|k, _| active_pids.contains(k));
        self.suspended_pids.retain(|k| active_pids.contains(k));
        self.efficiency_pids.retain(|k| active_pids.contains(k));

        // Disks
        let mut drives = Vec::new();
        for d in self.disks.list() {
            let total = d.total_space();
            let avail = d.available_space();
            let used = total.saturating_sub(avail);
            let pct = if total > 0 {
                ((used as f64 / total as f64) * 100.0) as f32
            } else {
                0.0
            };
            drives.push(DiskDriveInfo {
                name: d.name().to_string_lossy().to_string(),
                mount_point: d.mount_point().to_string_lossy().to_string(),
                file_system: d.file_system().to_string_lossy().to_string(),
                kind: format!("{:?}", d.kind()),
                total_bytes: total,
                available_bytes: avail,
                used_bytes: used,
                usage_percent: pct.clamp(0.0, 100.0),
            });
        }

        let disk_metrics = DiskMetrics {
            read_bytes_per_sec: total_disk_read,
            write_bytes_per_sec: total_disk_write,
            drives,
        };

        // Networks
        let mut total_rx_sec: u64 = 0;
        let mut total_tx_sec: u64 = 0;
        let mut total_rx_all: u64 = 0;
        let mut total_tx_all: u64 = 0;
        let mut primary_iface = String::new();
        let mut max_iface_traffic: u64 = 0;
        let mut interfaces = Vec::new();

        for (iface_name, data) in &self.networks {
            let rx = data.received();
            let tx = data.transmitted();
            let tot_rx = data.total_received();
            let tot_tx = data.total_transmitted();
            total_rx_sec = total_rx_sec.saturating_add(rx);
            total_tx_sec = total_tx_sec.saturating_add(tx);
            total_rx_all = total_rx_all.saturating_add(tot_rx);
            total_tx_all = total_tx_all.saturating_add(tot_tx);

            let combined = tot_rx.saturating_add(tot_tx);
            if combined >= max_iface_traffic && !iface_name.to_lowercase().contains("loopback") {
                max_iface_traffic = combined;
                primary_iface = iface_name.clone();
            }

            let ips: Vec<String> = data
                .ip_networks()
                .iter()
                .map(|ip| ip.addr.to_string())
                .collect();

            interfaces.push(NetworkInterfaceInfo {
                name: iface_name.clone(),
                ip_addresses: ips,
                mac_address: data.mac_address().to_string(),
                rx_bytes_per_sec: rx,
                tx_bytes_per_sec: tx,
                total_rx_bytes: tot_rx,
                total_tx_bytes: tot_tx,
            });
        }

        interfaces.sort_by(|a, b| {
            (b.total_rx_bytes + b.total_tx_bytes).cmp(&(a.total_rx_bytes + a.total_tx_bytes))
        });

        let network_metrics = NetworkMetrics {
            rx_bytes_per_sec: total_rx_sec,
            tx_bytes_per_sec: total_tx_sec,
            total_rx_bytes: total_rx_all,
            total_tx_bytes: total_tx_all,
            primary_interface: if primary_iface.is_empty() {
                "Netzwerk".to_string()
            } else {
                primary_iface
            },
            interfaces,
        };

        // Listening ports count refreshed every 4 ticks
        if self.tick_count % 4 == 1 {
            let empty_map = HashMap::new();
            let conns = network::list_connections(&empty_map);
            self.last_listening_ports = conns
                .iter()
                .filter(|c| c.state == "LISTENING")
                .count();
        }

        // Top 8 CPU & RAM blame snapshots for Spike-Blame & Range Analytics
        let accounted_cpu: f32 = processes.iter().map(|p| p.cpu_percent).sum();
        let unaccounted_cpu = ((total_cpu - accounted_cpu).max(0.0) * 10.0).round() / 10.0;

        let mut by_cpu = processes.clone();
        by_cpu.sort_by(|a, b| {
            b.cpu_percent
                .partial_cmp(&a.cpu_percent)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let top_cpu: Vec<BlameProcess> = by_cpu
            .iter()
            .take(8)
            .map(|p| BlameProcess {
                pid: p.pid,
                name: p.name.clone(),
                subtitle: p.subtitle.clone(),
                category: p.category.clone(),
                cpu_percent: p.cpu_percent,
                memory_bytes: p.memory_bytes,
            })
            .collect();

        let mut by_ram = processes.clone();
        by_ram.sort_by(|a, b| b.memory_bytes.cmp(&a.memory_bytes));
        let top_ram: Vec<BlameProcess> = by_ram
            .iter()
            .take(8)
            .map(|p| BlameProcess {
                pid: p.pid,
                name: p.name.clone(),
                subtitle: p.subtitle.clone(),
                category: p.category.clone(),
                cpu_percent: p.cpu_percent,
                memory_bytes: p.memory_bytes,
            })
            .collect();

        // Detect Spikes dynamically against rolling average of last 10 points
        let avg_recent_cpu = if self.history.len() >= 5 {
            let slice: Vec<f32> = self
                .history
                .iter()
                .rev()
                .take(10)
                .map(|h| h.cpu_percent)
                .collect();
            slice.iter().sum::<f32>() / slice.len() as f32
        } else {
            total_cpu
        };

        let gpu_pct = gpu_metrics.usage_percent.unwrap_or(0.0);
        let disk_mb = (total_disk_read + total_disk_write) as f32 / (1024.0 * 1024.0);
        let net_kb = (total_rx_sec + total_tx_sec) as f32 / 1024.0;

        let mut is_spike = false;
        let mut spike_reason = None;

        if self.history.len() >= 5 && (total_cpu > 75.0 || (total_cpu - avg_recent_cpu) > 25.0) {
            is_spike = true;
            if let Some(culprit) = top_cpu.first() {
                if culprit.cpu_percent >= 8.0 && culprit.cpu_percent >= unaccounted_cpu * 0.5 {
                    spike_reason = Some(format!(
                        "CPU-Spike ({:.0}%) durch {} ({:.0}%)",
                        total_cpu, culprit.name, culprit.cpu_percent
                    ));
                } else if unaccounted_cpu >= 15.0 {
                    spike_reason = Some(format!(
                        "CPU-Spike ({:.0}%) — kurzlebige Prozesse / Kernel",
                        total_cpu
                    ));
                } else {
                    spike_reason = Some(format!("CPU-Spike ({:.0}%)", total_cpu));
                }
            }
        } else if ram_percent > 88.0 {
            is_spike = true;
            if let Some(culprit) = top_ram.first() {
                spike_reason = Some(format!(
                    "Hoher RAM ({:.0}%) durch {}",
                    ram_percent, culprit.name
                ));
            }
        } else if gpu_pct > 85.0 {
            is_spike = true;
            spike_reason = Some(format!("GPU-Spitze ({:.0}%)", gpu_pct));
        }

        let timestamp_ms = Utc::now().timestamp_millis();
        let latest_point = HistoryPoint {
            timestamp_ms,
            cpu_percent: (total_cpu * 10.0).round() / 10.0,
            ram_percent: (ram_percent * 10.0).round() / 10.0,
            gpu_percent: (gpu_pct * 10.0).round() / 10.0,
            disk_mb_per_sec: (disk_mb * 10.0).round() / 10.0,
            net_kb_per_sec: (net_kb * 10.0).round() / 10.0,
            is_spike,
            spike_reason,
            unaccounted_cpu_percent: unaccounted_cpu,
            top_cpu,
            top_ram,
        };

        if self.history.len() >= MAX_HISTORY_POINTS {
            self.history.pop_front();
        }
        self.history.push_back(latest_point.clone());

        let battery = query_battery();

        let system_summary = SystemSummary {
            hostname: System::host_name().unwrap_or_else(|| "Windows PC".to_string()),
            os_name: System::long_os_version()
                .or_else(System::name)
                .unwrap_or_else(|| "Windows".to_string()),
            uptime_seconds: System::uptime(),
            process_count: processes.len(),
            listening_ports_count: self.last_listening_ports,
            active_profile: self.active_profile.clone(),
        };

        TelemetrySnapshot {
            timestamp_ms,
            cpu: cpu_metrics,
            memory: memory_metrics,
            gpu: gpu_metrics,
            disk: disk_metrics,
            network: network_metrics,
            battery,
            system: system_summary,
            processes,
            latest_point,
        }
    }
}

fn join_cmd(cmd: &[std::ffi::OsString]) -> String {
    cmd.iter()
        .map(|s| s.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(" ")
}

fn compute_group_key(name: &str) -> String {
    let lower = name.to_lowercase();
    let trimmed = lower.strip_suffix(".exe").unwrap_or(&lower);
    match trimmed {
        "chrome" | "googleupdate" => "Google Chrome".to_string(),
        "msedge" | "msedgewebview2" => "Microsoft Edge".to_string(),
        "firefox" => "Mozilla Firefox".to_string(),
        "brave" => "Brave Browser".to_string(),
        "opera" => "Opera".to_string(),
        "code" | "code - insiders" => "VS Code".to_string(),
        "discord" => "Discord".to_string(),
        "spotify" => "Spotify".to_string(),
        "steam" | "steamwebhelper" => "Steam".to_string(),
        "svchost" => "Windows Dienst-Host".to_string(),
        "explorer" => "Windows Explorer".to_string(),
        "windowsterminal" | "openconsole" | "conhost" => "Terminal".to_string(),
        "pwsh" | "powershell" => "PowerShell".to_string(),
        "node" => "Node.js".to_string(),
        "python" | "python3" | "pythonw" => "Python".to_string(),
        _ => {
            // Pretty title-case strip .exe
            let base = name
                .strip_suffix(".exe")
                .or_else(|| name.strip_suffix(".EXE"))
                .unwrap_or(name);
            base.to_string()
        }
    }
}

fn classify_process(name: &str, exe_path: &str, cmd_line: &str) -> String {
    let n = name.to_lowercase();
    let p = exe_path.to_lowercase();
    let c = cmd_line.to_lowercase();

    if matches!(
        n.as_str(),
        "chrome.exe"
            | "msedge.exe"
            | "firefox.exe"
            | "brave.exe"
            | "opera.exe"
            | "vivaldi.exe"
            | "arc.exe"
            | "msedgewebview2.exe"
    ) {
        return "browser".to_string();
    }

    if matches!(
        n.as_str(),
        "code.exe"
            | "node.exe"
            | "python.exe"
            | "python3.exe"
            | "pythonw.exe"
            | "cargo.exe"
            | "rustc.exe"
            | "rust-analyzer.exe"
            | "git.exe"
            | "pwsh.exe"
            | "powershell.exe"
            | "cmd.exe"
            | "windowsterminal.exe"
            | "docker.exe"
            | "wsl.exe"
            | "vmmem"
            | "vmmemwsl"
            | "devenv.exe"
            | "idea64.exe"
            | "pycharm64.exe"
            | "dotnet.exe"
            | "java.exe"
            | "esbuild.exe"
            | "vite.exe"
            | "postgres.exe"
            | "mysqld.exe"
    ) || c.contains("vite")
        || c.contains("webpack")
        || c.contains("uvicorn")
        || c.contains("next dev")
    {
        return "dev".to_string();
    }

    if matches!(
        n.as_str(),
        "steam.exe"
            | "steamwebhelper.exe"
            | "epicgameslauncher.exe"
            | "battle.net.exe"
            | "riotclientservices.exe"
            | "xboxpcapp.exe"
            | "obs64.exe"
            | "nvidia overlay.exe"
    ) || p.contains("steamapps\\common")
        || p.contains("epic games")
        || p.contains("riot games")
    {
        return "game".to_string();
    }

    if matches!(
        n.as_str(),
        "system"
            | "registry"
            | "smss.exe"
            | "csrss.exe"
            | "wininit.exe"
            | "services.exe"
            | "lsass.exe"
            | "svchost.exe"
            | "dwm.exe"
            | "explorer.exe"
            | "taskhostw.exe"
            | "sihost.exe"
            | "ctfmon.exe"
            | "fontdrvhost.exe"
            | "memory compression"
            | "msmpeng.exe"
            | "searchindexer.exe"
            | "searchhost.exe"
            | "startmenuexperiencehost.exe"
            | "shellexperiencehost.exe"
            | "runtimebroker.exe"
            | "audiodg.exe"
            | "spoolsv.exe"
            | "winlogon.exe"
    ) || p.starts_with("c:\\windows\\system32")
        || p.starts_with("c:\\windows\\syswow64")
    {
        return "system".to_string();
    }

    if p.contains("program files") || p.contains("appdata\\local\\programs") {
        return "app".to_string();
    }

    "background".to_string()
}

fn extract_subtitle(name: &str, cmd_line: &str, exe_path: &str) -> String {
    let n = name.to_lowercase();
    let trimmed_cmd = cmd_line.trim();

    // Extract svchost service group (-s ServiceName or -k GroupName)
    if n == "svchost.exe" {
        let parts: Vec<&str> = trimmed_cmd.split_whitespace().collect();
        for w in parts.windows(2) {
            if w[0].eq_ignore_ascii_case("-s") {
                return format!("Dienst: {}", w[1]);
            }
        }
        for w in parts.windows(2) {
            if w[0].eq_ignore_ascii_case("-k") {
                return format!("Dienstgruppe: {}", w[1]);
            }
        }
        return "Windows Dienst-Host".to_string();
    }

    // Extract script / project name for node, python, pwsh, java, dotnet
    if matches!(
        n.as_str(),
        "node.exe" | "python.exe" | "python3.exe" | "pythonw.exe" | "pwsh.exe" | "powershell.exe" | "dotnet.exe"
    ) {
        let tokens: Vec<&str> = trimmed_cmd.split_whitespace().collect();
        for tok in tokens.iter().skip(1) {
            let clean = tok.trim_matches('"');
            if clean.starts_with('-') || clean.is_empty() {
                continue;
            }
            if let Some(fname) = std::path::Path::new(clean)
                .file_name()
                .and_then(|f| f.to_str())
            {
                if !fname.is_empty() {
                    return fname.to_string();
                }
            }
        }
    }

    // Browser process role (--type=renderer / gpu-process / utility)
    if matches!(
        n.as_str(),
        "chrome.exe" | "msedge.exe" | "brave.exe" | "opera.exe" | "msedgewebview2.exe"
    ) {
        if trimmed_cmd.contains("--type=gpu-process") {
            return "GPU-Rendering".to_string();
        }
        if trimmed_cmd.contains("--type=renderer") {
            return "Tab / Renderer".to_string();
        }
        if trimmed_cmd.contains("--type=utility") {
            return "Netzwerk / Utility".to_string();
        }
        if trimmed_cmd.contains("--type=crashpad") {
            return "Crash-Handler".to_string();
        }
        return "Hauptprozess".to_string();
    }

    if n == "explorer.exe" {
        return "Desktop & Taskleiste".to_string();
    }
    if n == "dwm.exe" {
        return "Desktopfenster-Manager".to_string();
    }
    if n == "msmpeng.exe" {
        return "Windows Defender".to_string();
    }

    // Fallback: parent folder name of executable if informative
    if !exe_path.is_empty() {
        if let Some(parent) = std::path::Path::new(exe_path)
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|f| f.to_str())
        {
            if !parent.eq_ignore_ascii_case("system32") && !parent.eq_ignore_ascii_case("bin") {
                return parent.to_string();
            }
        }
    }

    String::new()
}

#[cfg(windows)]
fn query_battery() -> BatteryMetrics {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

    unsafe {
        let mut status = SYSTEM_POWER_STATUS::default();
        if GetSystemPowerStatus(&mut status).is_ok() {
            // BatteryFlag == 128 means no system battery
            let has_battery = status.BatteryFlag != 128 && status.BatteryLifePercent <= 100;
            let percent = if has_battery {
                Some(status.BatteryLifePercent)
            } else {
                None
            };
            let is_charging = (status.BatteryFlag & 8) != 0;
            let is_ac_plugged = status.ACLineStatus == 1;
            let remaining_seconds =
                if has_battery && status.BatteryLifeTime != u32::MAX && status.BatteryLifeTime > 0 {
                    Some(status.BatteryLifeTime)
                } else {
                    None
                };

            return BatteryMetrics {
                has_battery,
                percent,
                is_charging,
                is_ac_plugged,
                remaining_seconds,
            };
        }
    }

    BatteryMetrics {
        has_battery: false,
        percent: None,
        is_charging: false,
        is_ac_plugged: true,
        remaining_seconds: None,
    }
}

#[cfg(not(windows))]
fn query_battery() -> BatteryMetrics {
    BatteryMetrics {
        has_battery: false,
        percent: None,
        is_charging: false,
        is_ac_plugged: true,
        remaining_seconds: None,
    }
}
