use crate::models::GpuMetrics;
use std::collections::HashMap;

#[cfg(windows)]
mod nvml {
    use std::ffi::c_void;
    use windows::core::{s, w};
    use windows::Win32::Foundation::{FreeLibrary, HMODULE};
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

    const NVML_SUCCESS: u32 = 0;
    const NVML_TEMPERATURE_GPU: u32 = 0;

    #[repr(C)]
    #[derive(Default)]
    struct NvmlMemory {
        total: u64,
        free: u64,
        used: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct NvmlUtilization {
        gpu: u32,
        memory: u32,
    }

    type NvmlInitV2Fn = unsafe extern "C" fn() -> u32;
    type NvmlShutdownFn = unsafe extern "C" fn() -> u32;
    type NvmlDeviceGetHandleByIndexV2Fn =
        unsafe extern "C" fn(index: u32, device: *mut *mut c_void) -> u32;
    type NvmlDeviceGetNameFn =
        unsafe extern "C" fn(device: *mut c_void, name: *mut u8, length: u32) -> u32;
    type NvmlDeviceGetMemoryInfoFn =
        unsafe extern "C" fn(device: *mut c_void, memory: *mut NvmlMemory) -> u32;
    type NvmlDeviceGetTemperatureFn =
        unsafe extern "C" fn(device: *mut c_void, sensor_type: u32, temp: *mut u32) -> u32;
    type NvmlDeviceGetPowerUsageFn =
        unsafe extern "C" fn(device: *mut c_void, power: *mut u32) -> u32;
    type NvmlDeviceGetUtilizationRatesFn =
        unsafe extern "C" fn(device: *mut c_void, utilization: *mut NvmlUtilization) -> u32;

    pub struct NvmlSample {
        pub name: Option<String>,
        pub usage_percent: Option<f32>,
        pub vram_used_bytes: u64,
        pub vram_total_bytes: u64,
        pub temperature_c: Option<f32>,
        pub power_watts: Option<f32>,
    }

    pub struct NvmlClient {
        lib: HMODULE,
        device: *mut c_void,
        cached_name: Option<String>,
        shutdown_fn: NvmlShutdownFn,
        get_memory_fn: NvmlDeviceGetMemoryInfoFn,
        get_temp_fn: Option<NvmlDeviceGetTemperatureFn>,
        get_power_fn: Option<NvmlDeviceGetPowerUsageFn>,
        get_util_fn: Option<NvmlDeviceGetUtilizationRatesFn>,
    }

    // SAFETY: NvmlClient is only accessed exclusively via Mutex<Option<TelemetryEngine>>.
    unsafe impl Send for NvmlClient {}

    impl Drop for NvmlClient {
        fn drop(&mut self) {
            unsafe {
                let _ = (self.shutdown_fn)();
                let _ = FreeLibrary(self.lib);
            }
        }
    }

    impl NvmlClient {
        pub fn try_load() -> Option<Self> {
            unsafe {
                let lib = LoadLibraryW(w!("nvml.dll"))
                    .or_else(|_| {
                        LoadLibraryW(w!(
                            "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvml.dll"
                        ))
                    })
                    .ok()?;

                let init_ptr = GetProcAddress(lib, s!("nvmlInit_v2"));
                let shutdown_ptr = GetProcAddress(lib, s!("nvmlShutdown"));
                let handle_ptr = GetProcAddress(lib, s!("nvmlDeviceGetHandleByIndex_v2"));
                let mem_ptr = GetProcAddress(lib, s!("nvmlDeviceGetMemoryInfo"));

                let (Some(init_p), Some(shutdown_p), Some(handle_p), Some(mem_p)) =
                    (init_ptr, shutdown_ptr, handle_ptr, mem_ptr)
                else {
                    let _ = FreeLibrary(lib);
                    return None;
                };

                let init_fn: NvmlInitV2Fn = std::mem::transmute(init_p);
                let shutdown_fn: NvmlShutdownFn = std::mem::transmute(shutdown_p);
                let handle_fn: NvmlDeviceGetHandleByIndexV2Fn = std::mem::transmute(handle_p);
                let get_memory_fn: NvmlDeviceGetMemoryInfoFn = std::mem::transmute(mem_p);

                if init_fn() != NVML_SUCCESS {
                    let _ = FreeLibrary(lib);
                    return None;
                }

                let mut device: *mut c_void = std::ptr::null_mut();
                if handle_fn(0, &mut device) != NVML_SUCCESS || device.is_null() {
                    let _ = shutdown_fn();
                    let _ = FreeLibrary(lib);
                    return None;
                }

                let get_temp_fn = GetProcAddress(lib, s!("nvmlDeviceGetTemperature"))
                    .map(|p| std::mem::transmute::<_, NvmlDeviceGetTemperatureFn>(p));
                let get_power_fn = GetProcAddress(lib, s!("nvmlDeviceGetPowerUsage"))
                    .map(|p| std::mem::transmute::<_, NvmlDeviceGetPowerUsageFn>(p));
                let get_util_fn = GetProcAddress(lib, s!("nvmlDeviceGetUtilizationRates"))
                    .map(|p| std::mem::transmute::<_, NvmlDeviceGetUtilizationRatesFn>(p));
                let get_name_fn = GetProcAddress(lib, s!("nvmlDeviceGetName"))
                    .map(|p| std::mem::transmute::<_, NvmlDeviceGetNameFn>(p));

                let cached_name = get_name_fn.and_then(|f| {
                    let mut buf = [0u8; 96];
                    if f(device, buf.as_mut_ptr(), buf.len() as u32) == NVML_SUCCESS {
                        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
                        let s = String::from_utf8_lossy(&buf[..end]).trim().to_string();
                        if !s.is_empty() {
                            return Some(s);
                        }
                    }
                    None
                });

                Some(Self {
                    lib,
                    device,
                    cached_name,
                    shutdown_fn,
                    get_memory_fn,
                    get_temp_fn,
                    get_power_fn,
                    get_util_fn,
                })
            }
        }

        pub fn poll(&self) -> Option<NvmlSample> {
            unsafe {
                let mut mem = NvmlMemory::default();
                if (self.get_memory_fn)(self.device, &mut mem) != NVML_SUCCESS {
                    return None;
                }

                let temperature_c = self.get_temp_fn.and_then(|f| {
                    let mut t: u32 = 0;
                    if f(self.device, NVML_TEMPERATURE_GPU, &mut t) == NVML_SUCCESS {
                        Some(t as f32)
                    } else {
                        None
                    }
                });

                let power_watts = self.get_power_fn.and_then(|f| {
                    let mut mw: u32 = 0;
                    if f(self.device, &mut mw) == NVML_SUCCESS {
                        Some(((mw as f32 / 1000.0) * 10.0).round() / 10.0)
                    } else {
                        None
                    }
                });

                let usage_percent = self.get_util_fn.and_then(|f| {
                    let mut util = NvmlUtilization::default();
                    if f(self.device, &mut util) == NVML_SUCCESS {
                        Some((util.gpu as f32).clamp(0.0, 100.0))
                    } else {
                        None
                    }
                });

                Some(NvmlSample {
                    name: self.cached_name.clone(),
                    usage_percent,
                    vram_used_bytes: mem.used,
                    vram_total_bytes: mem.total,
                    temperature_c,
                    power_watts,
                })
            }
        }
    }
}

pub struct GpuCollector {
    dxgi_name: String,
    dxgi_vendor: String,
    dxgi_vram_total: u64,
    tick_counter: u64,
    cached: GpuMetrics,
    cached_per_pid: HashMap<u32, f32>,
    #[cfg(windows)]
    nvml: Option<nvml::NvmlClient>,
    #[cfg(windows)]
    pdh_query: Option<(isize, isize)>,
    #[cfg(windows)]
    pdh_buffer: Vec<u8>,
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

        #[cfg(windows)]
        let nvml_client = nvml::NvmlClient::try_load();
        #[cfg(windows)]
        let has_nvml = nvml_client.is_some();
        #[cfg(not(windows))]
        let has_nvml = false;

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
            available: !dxgi_name.is_empty() || has_nvml,
        };

        #[cfg(windows)]
        let pdh_query = open_persistent_gpu_pdh();

        let mut collector = Self {
            dxgi_name,
            dxgi_vendor,
            dxgi_vram_total,
            tick_counter: 0,
            cached: initial,
            cached_per_pid: HashMap::new(),
            #[cfg(windows)]
            nvml: nvml_client,
            #[cfg(windows)]
            pdh_query,
            #[cfg(windows)]
            pdh_buffer: Vec::new(),
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
            .and_then(|(q, c)| collect_pdh_gpu_per_pid(q, c, &mut self.pdh_buffer));
        #[cfg(not(windows))]
        let pdh_res: Option<(f32, HashMap<u32, f32>)> = None;

        #[cfg(windows)]
        let has_nvml = self.nvml.is_some();
        #[cfg(not(windows))]
        let has_nvml = false;

        if let Some((pdh_total, per_pid)) = pdh_res {
            self.cached_per_pid = per_pid;
            if !has_nvml {
                self.cached.usage_percent = Some(pdh_total);
            }
        }

        // Poll NVML directly in-process (no subprocess spawn) every 2 ticks for VRAM, Temp, Power & Utilization
        if self.tick_counter == 1 || self.tick_counter % 2 == 0 {
            #[cfg(windows)]
            if let Some(ref client) = self.nvml {
                if let Some(sample) = client.poll() {
                    if let Some(name) = sample.name {
                        self.cached.name = name;
                    }
                    self.cached.vendor = "NVIDIA".to_string();
                    if let Some(u) = sample.usage_percent {
                        self.cached.usage_percent = Some(u);
                    }
                    self.cached.vram_used_bytes = sample.vram_used_bytes;
                    if sample.vram_total_bytes > 0 {
                        self.cached.vram_total_bytes = sample.vram_total_bytes;
                    }
                    self.cached.temperature_c = sample.temperature_c;
                    self.cached.power_watts = sample.power_watts;
                    self.cached.available = true;
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
fn collect_pdh_gpu_per_pid(
    query: isize,
    counter: isize,
    buffer: &mut Vec<u8>,
) -> Option<(f32, HashMap<u32, f32>)> {
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
            let needed = buf_size as usize;
            if buffer.len() < needed {
                buffer.resize(needed, 0);
            }
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
