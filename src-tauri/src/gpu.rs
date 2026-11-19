use crate::models::GpuMetrics;
use std::collections::HashMap;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct GpuCollector {
    dxgi_name: String,
    dxgi_vendor: String,
    dxgi_vram_total: u64,
    has_nvidia_smi: bool,
    tick_counter: u64,
    cached: GpuMetrics,
    cached_per_pid: HashMap<u32, f32>,
    #[cfg(windows)]
    pdh_query: Option<(isize, isize)>,
}

impl Drop for GpuCollector {
    fn drop(&mut self) {
        #[cfg(windows)]
        if let Some((query, _)) = self.pdh_query.take() {
            unsafe {
                let _ = windows::Win32::System::Performance::PdhCloseQuery(query);
            }
        }
    }
}

impl GpuCollector {
    pub fn new() -> Self {
        let (dxgi_name, dxgi_vendor, dxgi_vram_total) = query_dxgi_primary_adapter();
        let has_nvidia_smi = check_nvidia_smi();

        let initial = GpuMetrics {
            name: if dxgi_name.is_empty() {
                "GPU nicht erkannt".to_string()
            } else {
                dxgi_name.clone()
            },
            vendor: dxgi_vendor.clone(),
            usage_percent: None,
            vram_used_bytes: 0,
            vram_total_bytes: dxgi_vram_total,
            temperature_c: None,
            power_watts: None,
            available: !dxgi_name.is_empty() || has_nvidia_smi,
        };

        #[cfg(windows)]
        let pdh_query = open_persistent_gpu_pdh();

        let mut collector = Self {
            dxgi_name,
            dxgi_vendor,
            dxgi_vram_total,
            has_nvidia_smi,
            tick_counter: 0,
            cached: initial,
            cached_per_pid: HashMap::new(),
            #[cfg(windows)]
            pdh_query,
        };
        let _ = collector.refresh();
        collector
    }

    pub fn refresh(&mut self) -> (GpuMetrics, HashMap<u32, f32>) {
        self.tick_counter += 1;

        // Collect fast persistent PDH per-process GPU engine usage (< 1ms, works on NVIDIA/AMD/Intel!)
        #[cfg(windows)]
        let pdh_res = self
            .pdh_query
            .and_then(|(q, c)| collect_pdh_gpu_per_pid(q, c));
        #[cfg(not(windows))]
        let pdh_res: Option<(f32, HashMap<u32, f32>)> = None;

        if let Some((pdh_total, per_pid)) = pdh_res {
            self.cached_per_pid = per_pid;
            if !self.has_nvidia_smi {
                self.cached.usage_percent = Some(pdh_total);
            }
        }

        // Poll nvidia-smi every 2 ticks for exact VRAM, Temperature & Power Draw
        if self.tick_counter == 1 || self.tick_counter % 2 == 0 {
            if self.has_nvidia_smi {
                if let Some(nv) = poll_nvidia_smi() {
                    self.cached = nv;
                }
            }
            if self.cached.name.is_empty() && !self.dxgi_name.is_empty() {
                self.cached.name = self.dxgi_name.clone();
                self.cached.vendor = self.dxgi_vendor.clone();
                self.cached.vram_total_bytes = self.dxgi_vram_total;
                self.cached.available = true;
            }
        }

        (self.cached.clone(), self.cached_per_pid.clone())
    }
}

fn check_nvidia_smi() -> bool {
    let mut cmd = Command::new("nvidia-smi");
    cmd.arg("--version");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

fn poll_nvidia_smi() -> Option<GpuMetrics> {
    let mut cmd = Command::new("nvidia-smi");
    cmd.args([
        "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
        "--format=csv,noheader,nounits",
    ]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next()?.trim();
    let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
    if parts.len() < 6 {
        return None;
    }

    let name = parts[0].to_string();
    let usage = parts[1].parse::<f32>().ok();
    let vram_used_mb = parts[2].parse::<f64>().unwrap_or(0.0);
    let vram_total_mb = parts[3].parse::<f64>().unwrap_or(0.0);
    let temp = parts[4].parse::<f32>().ok();
    let power = parts[5].parse::<f32>().ok();

    Some(GpuMetrics {
        name,
        vendor: "NVIDIA".to_string(),
        usage_percent: usage,
        vram_used_bytes: (vram_used_mb * 1024.0 * 1024.0) as u64,
        vram_total_bytes: (vram_total_mb * 1024.0 * 1024.0) as u64,
        temperature_c: temp,
        power_watts: power,
        available: true,
    })
}

#[cfg(windows)]
fn query_dxgi_primary_adapter() -> (String, String, u64) {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};

    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
            return (String::new(), "Unknown".to_string(), 0);
        };

        let mut best_name = String::new();
        let mut best_vendor = "Unknown".to_string();
        let mut best_vram: u64 = 0;

        let mut idx = 0;
        while let Ok(adapter) = factory.EnumAdapters1(idx) {
            idx += 1;
            if let Ok(desc) = adapter.GetDesc1() {
                if (desc.Flags & 2) != 0 {
                    continue;
                }
                let vram = desc.DedicatedVideoMemory as u64;
                let end = desc
                    .Description
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(desc.Description.len());
                let name = String::from_utf16_lossy(&desc.Description[..end]);
                let vendor = match desc.VendorId {
                    0x10DE => "NVIDIA",
                    0x1002 | 0x1022 => "AMD",
                    0x8086 => "Intel",
                    _ => "GPU",
                }
                .to_string();

                if best_name.is_empty() || vram > best_vram {
                    best_name = name;
                    best_vendor = vendor;
                    best_vram = vram;
                }
            }
        }
        (best_name, best_vendor, best_vram)
    }
}

#[cfg(not(windows))]
fn query_dxgi_primary_adapter() -> (String, String, u64) {
    (String::new(), "Unknown".to_string(), 0)
}

#[cfg(windows)]
fn open_persistent_gpu_pdh() -> Option<(isize, isize)> {
    use windows::core::w;
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhOpenQueryW,
    };

    unsafe {
        let mut query = 0isize;
        if PdhOpenQueryW(None, 0, &mut query) != 0 {
            return None;
        }
        let mut counter = 0isize;
        let path = w!("\\GPU Engine(*)\\Utilization Percentage");
        if PdhAddEnglishCounterW(query, path, 0, &mut counter) != 0 {
            let _ = PdhCloseQuery(query);
            return None;
        }
        // Prime initial baseline sample
        let _ = PdhCollectQueryData(query);
        Some((query, counter))
    }
}

#[cfg(windows)]
fn collect_pdh_gpu_per_pid(query: isize, counter: isize) -> Option<(f32, HashMap<u32, f32>)> {
    use windows::Win32::System::Performance::{
        PdhCollectQueryData, PdhGetFormattedCounterArrayW, PDH_FMT_COUNTERVALUE_ITEM_W,
        PDH_FMT_DOUBLE,
    };

    unsafe {
        if PdhCollectQueryData(query) != 0 {
            return None;
        }

        let mut buf_size: u32 = 0;
        let mut item_count: u32 = 0;
        let _ = PdhGetFormattedCounterArrayW(
            counter,
            PDH_FMT_DOUBLE,
            &mut buf_size,
            &mut item_count,
            None,
        );

        let mut per_pid: HashMap<u32, f32> = HashMap::new();
        let mut engine_totals: HashMap<String, f32> = HashMap::new();

        if buf_size > 0 && item_count > 0 {
            let mut buffer = vec![0u8; buf_size as usize];
            let items_ptr = buffer.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
            if PdhGetFormattedCounterArrayW(
                counter,
                PDH_FMT_DOUBLE,
                &mut buf_size,
                &mut item_count,
                Some(items_ptr),
            ) == 0
            {
                let items = std::slice::from_raw_parts(items_ptr, item_count as usize);
                for item in items {
                    let val = item.FmtValue.Anonymous.doubleValue;
                    if !val.is_finite() || val <= 0.01 {
                        continue;
                    }
                    let name = item.szName.to_string().unwrap_or_default();
                    let v = (val as f32).clamp(0.0, 100.0);

                    // Parse "pid_12345_luid_..."
                    if let Some(rest) = name.strip_prefix("pid_") {
                        if let Some(pid_str) = rest.split('_').next() {
                            if let Ok(pid) = pid_str.parse::<u32>() {
                                let entry = per_pid.entry(pid).or_insert(0.0);
                                *entry = (*entry + v).min(100.0);
                            }
                        }
                    }

                    // Aggregate per engine type (e.g. "engtype_3D") to compute overall GPU peak like Task Manager
                    if let Some(idx) = name.find("engtype_") {
                        let eng_key = &name[idx..];
                        let e = engine_totals.entry(eng_key.to_string()).or_insert(0.0);
                        *e = (*e + v).min(100.0);
                    }
                }
            }
        }

        // Round per-pid values to 1 decimal place
        for v in per_pid.values_mut() {
            *v = (*v * 10.0).round() / 10.0;
        }

        let overall = engine_totals
            .values()
            .copied()
            .fold(0.0f32, f32::max)
            .clamp(0.0, 100.0);

        Some(((overall * 10.0).round() / 10.0, per_pid))
    }
}
