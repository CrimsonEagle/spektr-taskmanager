use crate::models::GpuMetrics;

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

        let mut collector = Self {
            dxgi_name,
            dxgi_vendor,
            dxgi_vram_total,
            has_nvidia_smi,
            tick_counter: 0,
            cached: initial,
        };
        collector.refresh();
        collector
    }

    pub fn refresh(&mut self) -> GpuMetrics {
        self.tick_counter += 1;
        // Poll GPU subprocess/metrics every 2 ticks to keep CPU footprint ultra-low
        if self.tick_counter == 1 || self.tick_counter % 2 == 0 {
            if self.has_nvidia_smi {
                if let Some(nv) = poll_nvidia_smi() {
                    self.cached = nv;
                    return self.cached.clone();
                }
            }
            // Fallback for AMD / Intel GPUs via DXGI + PDH counters
            if let Some(pdh_load) = poll_windows_gpu_load() {
                self.cached.usage_percent = Some(pdh_load);
            }
            if self.cached.name.is_empty() && !self.dxgi_name.is_empty() {
                self.cached.name = self.dxgi_name.clone();
                self.cached.vendor = self.dxgi_vendor.clone();
                self.cached.vram_total_bytes = self.dxgi_vram_total;
                self.cached.available = true;
            }
        }
        self.cached.clone()
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
                // Skip software/Microsoft Basic Render Driver (flags & 2)
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
fn poll_windows_gpu_load() -> Option<f32> {
    use std::ptr::null_mut;
    use windows::core::w;
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
        PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE,
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

        let _ = PdhCollectQueryData(query);
        std::thread::sleep(std::time::Duration::from_millis(60));
        if PdhCollectQueryData(query) != 0 {
            let _ = PdhCloseQuery(query);
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

        let mut max_val: f64 = 0.0;
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
                    if val.is_finite() && val > max_val {
                        max_val = val;
                    }
                }
            }
        }
        let _ = null_mut::<u8>();
        let _ = PdhCloseQuery(query);
        Some((max_val as f32).clamp(0.0, 100.0))
    }
}

#[cfg(not(windows))]
fn poll_windows_gpu_load() -> Option<f32> {
    None
}
