use crate::cpu_sensors::CpuSensorCollector;
use crate::disk_sensors::{normalize_drive_key, DiskSensorCollector};
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
use sysinfo::{
    Components, Disks, Networks, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind,
};

const MAX_HISTORY_POINTS: usize = 900; // 15 minutes at 1s interval
const TOP_BLAME_LIMIT: usize = 5;

struct CachedProcMeta {
    start_time: u64,
    name: String,
    exe_path: String,
    cmd_line: String,
    category: String,
    subtitle: String,
    group_key: String,
}

fn minimal_process_refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .with_memory()
        .with_exe(UpdateKind::OnlyIfNotSet)
        .with_cmd(UpdateKind::OnlyIfNotSet)
}

pub struct TelemetryEngine {
    sys: System,
    disks: Disks,
    networks: Networks,
    components: Components,
    has_temp_sensors: bool,
    cpu_sensors: CpuSensorCollector,
    disk_sensors: DiskSensorCollector,
    gpu: GpuCollector,
    win_cpu: WinCpuSampler,
    history: VecDeque<HistoryPoint>,
    proc_meta_cache: HashMap<u32, CachedProcMeta>,
    cached_hostname: String,
    cached_os_name: String,
    cached_cpu_brand: String,
    cached_net_per_pid: HashMap<u32, (u32, u32)>,
    suspended_pids: HashSet<u32>,
    efficiency_pids: HashSet<u32>,
    active_profile: String,
    profile_managed_pids: HashMap<u32, &'static str>,
    gpu_active_streak: HashMap<u32, u8>,
    last_listening_ports: usize,
    tick_count: u64,
}

impl TelemetryEngine {
    pub fn new() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_all();
        sys.refresh_memory();
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            minimal_process_refresh_kind(),
        );
        let disks = Disks::new_with_refreshed_list();
        let networks = Networks::new_with_refreshed_list();
        let components = Components::new_with_refreshed_list();
        let has_temp_sensors = components.iter().any(|c| {
            let l = c.label().to_lowercase();
            (l.contains("cpu") || l.contains("package") || l.contains("core"))
                && c.temperature().is_some()
        });
        let cpu_sensors = CpuSensorCollector::new();
        let disk_sensors = DiskSensorCollector::new();
        let gpu = GpuCollector::new();
        let win_cpu = WinCpuSampler::new();

        let cached_hostname = System::host_name().unwrap_or_else(|| "Windows PC".to_string());
        let cached_os_name = System::long_os_version()
            .or_else(System::name)
            .unwrap_or_else(|| "Windows".to_string());
        let cached_cpu_brand = sys
            .cpus()
            .first()
            .map(|c| c.brand().trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "CPU".to_string());

        Self {
            sys,
            disks,
            networks,
            components,
            has_temp_sensors,
            cpu_sensors,
            disk_sensors,
            gpu,
            win_cpu,
            history: VecDeque::with_capacity(MAX_HISTORY_POINTS + 1),
            proc_meta_cache: HashMap::new(),
            cached_hostname,
            cached_os_name,
            cached_cpu_brand,
            cached_net_per_pid: HashMap::new(),
            suspended_pids: HashSet::new(),
            efficiency_pids: HashSet::new(),
            active_profile: "normal".to_string(),
            profile_managed_pids: HashMap::new(),
            gpu_active_streak: HashMap::new(),
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

    pub fn apply_profile(&mut self, profile: &str, current_procs: &[ProcessEntry]) -> (usize, usize) {
        // First reset any previously profile-managed PIDs back to normal
        let prev_pids: Vec<(u32, &'static str)> = self.profile_managed_pids.drain().collect();
        let mut reset_count = 0usize;
        for (pid, mode) in prev_pids {
            let res = if mode == "eco" {
                self.efficiency_pids.remove(&pid);
                process_ops::set_efficiency_mode(pid, false)
            } else {
                process_ops::set_process_priority(pid, "normal")
            };
            if res.ok {
                reset_count += 1;
            }
        }

        self.active_profile = match profile {
            "eco" => "eco".to_string(),
            "gaming" => "gaming".to_string(),
            _ => "normal".to_string(),
        };

        if self.active_profile == "normal" {
            return (0, reset_count);
        }

        self.enforce_active_profile(current_procs)
    }

    fn enforce_active_profile(&mut self, procs: &[ProcessEntry]) -> (usize, usize) {
        if self.active_profile == "normal" {
            return (0, 0);
        }

        let self_pid = std::process::id();
        let mut boosted = 0usize;
        let mut throttled = 0usize;

        for p in procs {
            if p.pid == self_pid || p.pid <= 4 || p.category == "system" {
                continue;
            }

            let existing = self.profile_managed_pids.get(&p.pid).copied();

            match self.active_profile.as_str() {
                "eco" => {
                    if existing.is_none()
                        && (p.category == "background" || p.category == "browser")
                    {
                        if process_ops::set_efficiency_mode(p.pid, true).ok {
                            self.efficiency_pids.insert(p.pid);
                            self.profile_managed_pids.insert(p.pid, "eco");
                            throttled += 1;
                        }
                    }
                }
                "gaming" => {
                    // Auto-detect games via category OR sustained GPU load (>15% for >=2 ticks) on non-browser/non-dev apps
                    let gpu_streak = self.gpu_active_streak.get(&p.pid).copied().unwrap_or(0);
                    let is_active_3d_app = gpu_streak >= 2
                        && p.category != "browser"
                        && p.category != "dev";
                    let should_boost = p.category == "game" || is_active_3d_app;

                    if should_boost {
                        if existing != Some("high") {
                            if process_ops::set_process_priority(p.pid, "high").ok {
                                self.profile_managed_pids.insert(p.pid, "high");
                                boosted += 1;
                            }
                        }
                    } else if existing.is_none() && p.category == "background" {
                        if process_ops::set_process_priority(p.pid, "below_normal").ok {
                            self.profile_managed_pids.insert(p.pid, "below_normal");
                            throttled += 1;
                        }
                    }
                }
                _ => {}
            }
        }

        (boosted, throttled)
    }

    pub fn history(&self) -> Vec<HistoryPoint> {
        self.history.iter().cloned().collect()
    }

    pub fn process_lookup(&self) -> HashMap<u32, (String, String, String)> {
        let mut map = HashMap::with_capacity(self.sys.processes().len());
        for (pid, proc_) in self.sys.processes() {
            let pid_u32 = pid.as_u32();
            if let Some(meta) = self.proc_meta_cache.get(&pid_u32) {
                map.insert(
                    pid_u32,
                    (
                        meta.name.clone(),
                        meta.subtitle.clone(),
                        meta.category.clone(),
                    ),
                );
            } else {
                let name = proc_.name().to_string_lossy().to_string();
                let exe = proc_
                    .exe()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();
                let cmd = join_cmd(proc_.cmd());
                let category = classify_process(&name, &exe, &cmd);
                let subtitle = extract_subtitle(&name, &cmd, &exe);
                map.insert(pid_u32, (name, subtitle, category));
            }
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
        self.sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            minimal_process_refresh_kind(),
        );
        let win_snap = self.win_cpu.sample();
        self.networks.refresh(true);

        if self.tick_count % 20 == 1 {
            self.disks.refresh(true);
        }
        if self.has_temp_sensors && self.tick_count % 5 == 1 {
            self.components.refresh(true);
        }

        let (gpu_metrics, gpu_per_pid) = self.gpu.refresh();

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
        let brand = self.cached_cpu_brand.clone();
        let fallback_base_mhz = cpus.first().map(|c| c.frequency()).unwrap_or(0);
        let cpu_sensor = self.cpu_sensors.sample(fallback_base_mhz, logical_cores);
        let base_frequency_mhz = cpu_sensor.base_freq_mhz.unwrap_or(fallback_base_mhz);
        let frequency_mhz = cpu_sensor.effective_freq_mhz.unwrap_or(base_frequency_mhz);
        let per_core_frequency_mhz = cpu_sensor.per_core_freq_mhz;

        let sysinfo_temp = if self.has_temp_sensors {
            self.components
                .iter()
                .find(|c| {
                    let l = c.label().to_lowercase();
                    l.contains("cpu") || l.contains("package") || l.contains("core")
                })
                .and_then(|c| c.temperature())
        } else {
            None
        };
        let cpu_temp = cpu_sensor.temperature_c.or(sysinfo_temp);
        let cpu_power = cpu_sensor.power_watts;
        let sensor_source = cpu_sensor.sensor_source.or_else(|| {
            if sysinfo_temp.is_some() {
                Some("ACPI".to_string())
            } else {
                None
            }
        });

        let cpu_metrics = CpuMetrics {
            total_usage: total_cpu,
            per_core,
            per_core_frequency_mhz,
            brand,
            frequency_mhz,
            base_frequency_mhz,
            physical_cores,
            logical_cores,
            temperature_c: cpu_temp,
            power_watts: cpu_power,
            sensor_source,
        };

        // Memory (with real Commit / Kernel Pool / System Cache via K32GetPerformanceInfo)
        let total_mem = self.sys.total_memory();
        let used_mem = self.sys.used_memory();
        let avail_mem = self.sys.available_memory();
        let perf_mem = query_perf_memory_info();
        let cached_mem = perf_mem
            .as_ref()
            .map(|p| p.system_cache_bytes)
            .unwrap_or_else(|| total_mem.saturating_sub(used_mem).min(avail_mem / 2));
        let (commit_total_bytes, commit_limit_bytes, paged_pool_bytes, non_paged_pool_bytes) =
            perf_mem
                .map(|p| {
                    (
                        p.commit_total_bytes,
                        p.commit_limit_bytes,
                        p.paged_pool_bytes,
                        p.non_paged_pool_bytes,
                    )
                })
                .unwrap_or((0, 0, 0, 0));
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
            commit_total_bytes,
            commit_limit_bytes,
            paged_pool_bytes,
            non_paged_pool_bytes,
        };

        // Processes + aggregate disk I/O
        let mut total_disk_read: u64 = 0;
        let mut total_disk_write: u64 = 0;
        let mut active_pids = HashSet::new();
        let mut processes = Vec::with_capacity(self.sys.processes().len());

        for (pid, proc_) in self.sys.processes() {
            let pid_u32 = pid.as_u32();
            active_pids.insert(pid_u32);

            let start_time = proc_.start_time();
            let needs_meta = match self.proc_meta_cache.get(&pid_u32) {
                Some(meta) => meta.start_time != start_time,
                None => true,
            };
            if needs_meta {
                let name = proc_.name().to_string_lossy().to_string();
                let exe_path = proc_
                    .exe()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();
                let cmd_line = join_cmd(proc_.cmd());
                let category = classify_process(&name, &exe_path, &cmd_line);
                let subtitle = extract_subtitle(&name, &cmd_line, &exe_path);
                let group_key = compute_group_key(&name);
                self.proc_meta_cache.insert(
                    pid_u32,
                    CachedProcMeta {
                        start_time,
                        name,
                        exe_path,
                        cmd_line,
                        category,
                        subtitle,
                        group_key,
                    },
                );
            }
            let meta = &self.proc_meta_cache[&pid_u32];

            let win_info = win_snap.per_pid.get(&pid_u32);
            let cpu_percent = win_info
                .map(|w| w.cpu_percent)
                .unwrap_or_else(|| (proc_.cpu_usage() / logical_cores as f32).clamp(0.0, 100.0));
            let gpu_percent = gpu_per_pid.get(&pid_u32).copied().unwrap_or(0.0);
            let mem_bytes = proc_.memory();
            let sys_disk = proc_.disk_usage();
            let disk_read_sec = win_info
                .map(|w| w.disk_read_bytes_per_sec)
                .unwrap_or(sys_disk.read_bytes);
            let disk_write_sec = win_info
                .map(|w| w.disk_write_bytes_per_sec)
                .unwrap_or(sys_disk.written_bytes);
            let total_disk_read_p = win_info
                .map(|w| w.total_disk_read_bytes)
                .unwrap_or(sys_disk.total_read_bytes);
            let total_disk_write_p = win_info
                .map(|w| w.total_disk_write_bytes)
                .unwrap_or(sys_disk.total_written_bytes);

            total_disk_read = total_disk_read.saturating_add(disk_read_sec);
            total_disk_write = total_disk_write.saturating_add(disk_write_sec);

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
                name: meta.name.clone(),
                group_key: meta.group_key.clone(),
                subtitle: meta.subtitle.clone(),
                category: meta.category.clone(),
                cpu_percent: (cpu_percent * 10.0).round() / 10.0,
                gpu_percent,
                memory_bytes: mem_bytes,
                disk_read_bytes_per_sec: disk_read_sec,
                disk_write_bytes_per_sec: disk_write_sec,
                total_disk_read_bytes: total_disk_read_p,
                total_disk_write_bytes: total_disk_write_p,
                status: status_str,
                is_suspended,
                is_efficiency_mode,
                run_time_seconds: proc_.run_time(),
                exe_path: meta.exe_path.clone(),
                cmd_line: meta.cmd_line.clone(),
                handle_count,
                thread_count,
                cpu_history: Vec::new(),
            });
        }

        // Cleanup exited PIDs from caches
        self.proc_meta_cache.retain(|k, _| active_pids.contains(k));
        self.suspended_pids.retain(|k| active_pids.contains(k));
        self.efficiency_pids.retain(|k| active_pids.contains(k));
        self.profile_managed_pids
            .retain(|k, _| active_pids.contains(k));
        self.gpu_active_streak
            .retain(|k, _| active_pids.contains(k));

        // Update GPU activity streak for smart 3D/game auto-detection in Boost mode
        for p in &processes {
            if p.gpu_percent >= 15.0 {
                let s = self.gpu_active_streak.entry(p.pid).or_insert(0);
                *s = s.saturating_add(1);
            } else if let Some(s) = self.gpu_active_streak.get_mut(&p.pid) {
                *s = s.saturating_sub(1);
            }
        }

        // Continuously enforce active Eco / Boost profile on newly started processes & active 3D games
        if self.active_profile != "normal" {
            let _ = self.enforce_active_profile(&processes);
            // Sync efficiency flags back into the snapshot's ProcessEntry list
            for p in &mut processes {
                p.is_efficiency_mode = self.efficiency_pids.contains(&p.pid);
            }
        }

        // Disks (enhanced with Windows PDH Active Time %, Response Time ms, per-drive R/W & NVMe/SATA hardware info)
        let disk_snap = self.disk_sensors.sample();
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
            let mount_point = d.mount_point().to_string_lossy().to_string();
            let drive_key = normalize_drive_key(&mount_point);
            let hw = self.disk_sensors.get_drive_hardware(&mount_point);
            let pdh_drive = disk_snap.per_drive.get(&drive_key);

            drives.push(DiskDriveInfo {
                name: d.name().to_string_lossy().to_string(),
                mount_point,
                file_system: d.file_system().to_string_lossy().to_string(),
                kind: format!("{:?}", d.kind()),
                model: hw.model,
                bus_type: hw.bus_type,
                is_system_drive: hw.is_system_drive,
                total_bytes: total,
                available_bytes: avail,
                used_bytes: used,
                usage_percent: pct.clamp(0.0, 100.0),
                active_percent: pdh_drive.map_or(0.0, |p| p.active_percent),
                avg_response_ms: pdh_drive.map_or(0.0, |p| p.avg_response_ms),
                read_bytes_per_sec: pdh_drive.map_or(0, |p| p.read_bytes_per_sec),
                write_bytes_per_sec: pdh_drive.map_or(0, |p| p.write_bytes_per_sec),
            });
        }

        let final_disk_read = disk_snap
            .total_read_bytes_per_sec
            .unwrap_or(total_disk_read);
        let final_disk_write = disk_snap
            .total_write_bytes_per_sec
            .unwrap_or(total_disk_write);

        let disk_metrics = DiskMetrics {
            read_bytes_per_sec: final_disk_read,
            write_bytes_per_sec: final_disk_write,
            active_percent: disk_snap.total_active_percent,
            avg_response_ms: disk_snap.total_avg_response_ms,
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

        // Active TCP/UDP connection counts per PID (lightweight IP Helper scan, refreshed every 2 ticks)
        if self.tick_count == 1 || self.tick_count % 2 == 1 {
            self.cached_net_per_pid = network::count_connections_per_pid();
            self.last_listening_ports = self
                .cached_net_per_pid
                .values()
                .map(|&(listening, _)| listening as usize)
                .sum();
        }
        let net_per_pid = &self.cached_net_per_pid;

        let to_blame = |p: &ProcessEntry| -> BlameProcess {
            let (listening, established) = net_per_pid.get(&p.pid).copied().unwrap_or((0, 0));
            BlameProcess {
                pid: p.pid,
                name: p.name.clone(),
                subtitle: p.subtitle.clone(),
                category: p.category.clone(),
                cpu_percent: p.cpu_percent,
                gpu_percent: p.gpu_percent,
                memory_bytes: p.memory_bytes,
                disk_bytes_per_sec: p
                    .disk_read_bytes_per_sec
                    .saturating_add(p.disk_write_bytes_per_sec),
                net_connections: established,
                net_listening_ports: listening,
            }
        };

        // Top 5 blame snapshots per metric for Spike-Blame & Range Analytics (zero Vec<ProcessEntry> clones)
        let accounted_cpu: f32 = processes.iter().map(|p| p.cpu_percent).sum();
        let unaccounted_cpu = ((total_cpu - accounted_cpu).max(0.0) * 10.0).round() / 10.0;

        let mut by_cpu: Vec<&ProcessEntry> = processes.iter().collect();
        by_cpu.sort_by(|a, b| {
            b.cpu_percent
                .partial_cmp(&a.cpu_percent)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let top_cpu: Vec<BlameProcess> = by_cpu
            .into_iter()
            .take(TOP_BLAME_LIMIT)
            .map(to_blame)
            .collect();

        let mut by_ram: Vec<&ProcessEntry> = processes.iter().collect();
        by_ram.sort_by(|a, b| b.memory_bytes.cmp(&a.memory_bytes));
        let top_ram: Vec<BlameProcess> = by_ram
            .into_iter()
            .take(TOP_BLAME_LIMIT)
            .map(to_blame)
            .collect();

        let mut by_gpu: Vec<&ProcessEntry> = processes
            .iter()
            .filter(|p| p.gpu_percent > 0.0)
            .collect();
        by_gpu.sort_by(|a, b| {
            b.gpu_percent
                .partial_cmp(&a.gpu_percent)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let top_gpu: Vec<BlameProcess> = by_gpu
            .into_iter()
            .take(TOP_BLAME_LIMIT)
            .map(to_blame)
            .collect();

        let mut by_disk: Vec<&ProcessEntry> = processes
            .iter()
            .filter(|p| p.disk_read_bytes_per_sec + p.disk_write_bytes_per_sec > 0)
            .collect();
        by_disk.sort_by(|a, b| {
            (b.disk_read_bytes_per_sec + b.disk_write_bytes_per_sec)
                .cmp(&(a.disk_read_bytes_per_sec + a.disk_write_bytes_per_sec))
        });
        let top_disk: Vec<BlameProcess> = by_disk
            .into_iter()
            .take(TOP_BLAME_LIMIT)
            .map(to_blame)
            .collect();

        let mut by_net: Vec<&ProcessEntry> = processes
            .iter()
            .filter(|p| {
                let (lis, est) = net_per_pid.get(&p.pid).copied().unwrap_or((0, 0));
                est > 0 || lis > 0
            })
            .collect();
        by_net.sort_by(|a, b| {
            let (al, ae) = net_per_pid.get(&a.pid).copied().unwrap_or((0, 0));
            let (bl, be) = net_per_pid.get(&b.pid).copied().unwrap_or((0, 0));
            be.cmp(&ae).then_with(|| bl.cmp(&al))
        });
        let top_net: Vec<BlameProcess> = by_net
            .into_iter()
            .take(TOP_BLAME_LIMIT)
            .map(to_blame)
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
        let disk_mb = (disk_metrics.read_bytes_per_sec + disk_metrics.write_bytes_per_sec) as f32
            / (1024.0 * 1024.0);
        let disk_active = disk_metrics.active_percent;
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
            disk_active_percent: (disk_active * 10.0).round() / 10.0,
            net_kb_per_sec: (net_kb * 10.0).round() / 10.0,
            gpu_engine_3d: gpu_metrics.engine_3d_percent,
            gpu_engine_copy: gpu_metrics.engine_copy_percent,
            gpu_engine_encode: gpu_metrics.engine_video_encode_percent,
            gpu_engine_decode: gpu_metrics.engine_video_decode_percent,
            is_spike,
            spike_reason,
            unaccounted_cpu_percent: unaccounted_cpu,
            top_cpu,
            top_ram,
            top_gpu,
            top_disk,
            top_net,
        };

        if self.history.len() >= MAX_HISTORY_POINTS {
            self.history.pop_front();
        }
        self.history.push_back(latest_point.clone());

        let battery = query_battery();

        let profile_managed_count = self.profile_managed_pids.len();
        let profile_boosted_count = self
            .profile_managed_pids
            .values()
            .filter(|&&m| m == "high")
            .count();

        let system_summary = SystemSummary {
            hostname: self.cached_hostname.clone(),
            os_name: self.cached_os_name.clone(),
            uptime_seconds: System::uptime(),
            process_count: processes.len(),
            listening_ports_count: self.last_listening_ports,
            active_profile: self.active_profile.clone(),
            profile_managed_count,
            profile_boosted_count,
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
        || p.contains("xboxgames")
        || p.contains("gog galaxy\\games")
        || p.contains("ubisoft game launcher\\games")
        || p.contains("ea games")
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

struct PerfMemoryInfo {
    system_cache_bytes: u64,
    commit_total_bytes: u64,
    commit_limit_bytes: u64,
    paged_pool_bytes: u64,
    non_paged_pool_bytes: u64,
}

#[cfg(windows)]
fn query_perf_memory_info() -> Option<PerfMemoryInfo> {
    use windows::Win32::System::ProcessStatus::{K32GetPerformanceInfo, PERFORMANCE_INFORMATION};

    unsafe {
        let mut info = PERFORMANCE_INFORMATION {
            cb: std::mem::size_of::<PERFORMANCE_INFORMATION>() as u32,
            ..Default::default()
        };
        if K32GetPerformanceInfo(&mut info, info.cb).as_bool() {
            let page_size = info.PageSize as u64;
            return Some(PerfMemoryInfo {
                system_cache_bytes: (info.SystemCache as u64).saturating_mul(page_size),
                commit_total_bytes: (info.CommitTotal as u64).saturating_mul(page_size),
                commit_limit_bytes: (info.CommitLimit as u64).saturating_mul(page_size),
                paged_pool_bytes: (info.KernelPaged as u64).saturating_mul(page_size),
                non_paged_pool_bytes: (info.KernelNonpaged as u64).saturating_mul(page_size),
            });
        }
    }
    None
}

#[cfg(not(windows))]
fn query_perf_memory_info() -> Option<PerfMemoryInfo> {
    None
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
