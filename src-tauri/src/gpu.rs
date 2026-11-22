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
    const NVML_CLOCK_GRAPHICS: u32 = 0;
    const NVML_CLOCK_MEM: u32 = 2;

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

    #[repr(C)]
    struct NvmlPciInfo {
        bus_id_legacy: [u8; 16],
        domain: u32,
        bus: u32,
        device: u32,
        pci_device_id: u32,
        pci_sub_system_id: u32,
        bus_id: [u8; 32],
    }

    impl Default for NvmlPciInfo {
        fn default() -> Self {
            Self {
                bus_id_legacy: [0; 16],
                domain: 0,
                bus: 0,
                device: 0,
                pci_device_id: 0,
                pci_sub_system_id: 0,
                bus_id: [0; 32],
            }
        }
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
    type NvmlDeviceGetPowerLimitFn =
        unsafe extern "C" fn(device: *mut c_void, limit: *mut u32) -> u32;
    type NvmlDeviceGetUtilizationRatesFn =
        unsafe extern "C" fn(device: *mut c_void, utilization: *mut NvmlUtilization) -> u32;
    type NvmlDeviceGetClockInfoFn =
        unsafe extern "C" fn(device: *mut c_void, clock_type: u32, clock: *mut u32) -> u32;
    type NvmlDeviceGetFanSpeedFn =
        unsafe extern "C" fn(device: *mut c_void, speed: *mut u32) -> u32;
    type NvmlDeviceGetPciInfoV3Fn =
        unsafe extern "C" fn(device: *mut c_void, pci: *mut NvmlPciInfo) -> u32;
    type NvmlSystemGetDriverVersionFn =
        unsafe extern "C" fn(version: *mut u8, length: u32) -> u32;

    pub struct NvmlSample {
        pub name: Option<String>,
        pub usage_percent: Option<f32>,
        pub vram_used_bytes: u64,
        pub vram_total_bytes: u64,
        pub temperature_c: Option<f32>,
        pub power_watts: Option<f32>,
        pub power_limit_watts: Option<f32>,
        pub clock_mhz: Option<u32>,
        pub memory_clock_mhz: Option<u32>,
        pub fan_speed_percent: Option<u32>,
        pub pci_location: Option<String>,
        pub driver_version: Option<String>,
    }

    pub struct NvmlClient {
        lib: HMODULE,
        device: *mut c_void,
        cached_name: Option<String>,
        cached_pci_location: Option<String>,
        cached_driver_version: Option<String>,
        cached_power_limit: Option<f32>,
        shutdown_fn: NvmlShutdownFn,
        get_memory_fn: NvmlDeviceGetMemoryInfoFn,
        get_temp_fn: Option<NvmlDeviceGetTemperatureFn>,
        get_power_fn: Option<NvmlDeviceGetPowerUsageFn>,
        get_util_fn: Option<NvmlDeviceGetUtilizationRatesFn>,
        get_clock_fn: Option<NvmlDeviceGetClockInfoFn>,
        get_fan_fn: Option<NvmlDeviceGetFanSpeedFn>,
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
                let get_power_limit_fn = GetProcAddress(lib, s!("nvmlDeviceGetPowerManagementLimit"))
                    .map(|p| std::mem::transmute::<_, NvmlDeviceGetPowerLimitFn>(p));
                let get_util_fn = GetProcAddress(lib, s!("nvmlDeviceGetUtilizationRates"))
                    .map(|p| std::mem::transmute::<_, NvmlDeviceGetUtilizationRatesFn>(p));
                let get_name_fn = GetProcAddress(lib, s!("nvmlDeviceGetName"))
                    .map(|p| std::mem::transmute::<_, NvmlDeviceGetNameFn>(p));
                let get_clock_fn = GetProcAddress(lib, s!("nvmlDeviceGetClockInfo"))
                    .map(|p| std::mem::transmute::<_, NvmlDeviceGetClockInfoFn>(p));
                let get_fan_fn = GetProcAddress(lib, s!("nvmlDeviceGetFanSpeed"))
                    .map(|p| std::mem::transmute::<_, NvmlDeviceGetFanSpeedFn>(p));
                let get_pci_fn = GetProcAddress(lib, s!("nvmlDeviceGetPciInfo_v3"))
                    .map(|p| std::mem::transmute::<_, NvmlDeviceGetPciInfoV3Fn>(p));
                let get_driver_fn = GetProcAddress(lib, s!("nvmlSystemGetDriverVersion"))
                    .map(|p| std::mem::transmute::<_, NvmlSystemGetDriverVersionFn>(p));

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

                let cached_pci_location = get_pci_fn.and_then(|f| {
                    let mut pci = NvmlPciInfo::default();
                    if f(device, &mut pci) == NVML_SUCCESS {
                        Some(format!(
                            "PCI-Bus {}, Gerät {}, Funktion 0",
                            pci.bus, pci.device
                        ))
                    } else {
                        None
                    }
                });

                let cached_driver_version = get_driver_fn.and_then(|f| {
                    let mut buf = [0u8; 80];
                    if f(buf.as_mut_ptr(), buf.len() as u32) == NVML_SUCCESS {
                        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
                        let s = String::from_utf8_lossy(&buf[..end]).trim().to_string();
                        if !s.is_empty() {
                            return Some(s);
                        }
                    }
                    None
                });

                let cached_power_limit = get_power_limit_fn.and_then(|f| {
                    let mut mw: u32 = 0;
                    if f(device, &mut mw) == NVML_SUCCESS && mw > 0 {
                        Some(((mw as f32 / 1000.0) * 10.0).round() / 10.0)
                    } else {
                        None
                    }
                });

                Some(Self {
                    lib,
                    device,
                    cached_name,
                    cached_pci_location,
                    cached_driver_version,
                    cached_power_limit,
                    shutdown_fn,
                    get_memory_fn,
                    get_temp_fn,
                    get_power_fn,
                    get_util_fn,
                    get_clock_fn,
                    get_fan_fn,
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

                let clock_mhz = self.get_clock_fn.and_then(|f| {
                    let mut mhz: u32 = 0;
                    if f(self.device, NVML_CLOCK_GRAPHICS, &mut mhz) == NVML_SUCCESS && mhz > 0 {
                        Some(mhz)
                    } else {
                        None
                    }
                });

                let memory_clock_mhz = self.get_clock_fn.and_then(|f| {
                    let mut mhz: u32 = 0;
                    if f(self.device, NVML_CLOCK_MEM, &mut mhz) == NVML_SUCCESS && mhz > 0 {
                        Some(mhz)
                    } else {
                        None
                    }
                });

                let fan_speed_percent = self.get_fan_fn.and_then(|f| {
                    let mut pct: u32 = 0;
                    if f(self.device, &mut pct) == NVML_SUCCESS && pct <= 100 {
                        Some(pct)
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
                    power_limit_watts: self.cached_power_limit,
                    clock_mhz,
                    memory_clock_mhz,
                    fan_speed_percent,
                    pci_location: self.cached_pci_location.clone(),
                    driver_version: self.cached_driver_version.clone(),
                })
            }
        }
    }
}

#[cfg(windows)]
struct GpuPdhHandles {
    query: windows::Win32::System::Performance::PDH_HQUERY,
    engine_counter: windows::Win32::System::Performance::PDH_HCOUNTER,
    dedicated_mem_counter: Option<windows::Win32::System::Performance::PDH_HCOUNTER>,
    shared_mem_counter: Option<windows::Win32::System::Performance::PDH_HCOUNTER>,
}

#[cfg(windows)]
unsafe impl Send for GpuPdhHandles {}

#[cfg(windows)]
struct GpuPdhSample {
    overall_percent: f32,
    engine_3d: f32,
    engine_copy: f32,
    engine_video_encode: f32,
    engine_video_decode: f32,
    dedicated_used_bytes: Option<u64>,
    shared_used_bytes: Option<u64>,
    per_pid: HashMap<u32, f32>,
}

pub struct GpuCollector {
    dxgi_name: String,
    dxgi_vendor: String,
    dxgi_vram_total: u64,
    dxgi_shared_total: u64,
    primary_luid_tag: Option<String>,
    reg_driver_version: Option<String>,
    reg_driver_date: Option<String>,
    tick_counter: u64,
    cached: GpuMetrics,
    cached_per_pid: HashMap<u32, f32>,
    #[cfg(windows)]
    nvml: Option<nvml::NvmlClient>,
    #[cfg(windows)]
    pdh: Option<GpuPdhHandles>,
    #[cfg(windows)]
    pdh_buffer: Vec<u8>,
}

impl Drop for GpuCollector {
    fn drop(&mut self) {
        #[cfg(windows)]
        if let Some(h) = self.pdh.take() {
            unsafe {
                let _ = windows::Win32::System::Performance::PdhCloseQuery(h.query);
            }
        }
    }
}

impl GpuCollector {
    pub fn new() -> Self {
        let (dxgi_name, dxgi_vendor, dxgi_vram_total, dxgi_shared_total, primary_luid_tag) =
            query_dxgi_primary_adapter();
        let (reg_driver_version, reg_driver_date) = query_gpu_driver_registry(&dxgi_name);

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
            shared_used_bytes: 0,
            shared_total_bytes: dxgi_shared_total,
            temperature_c: None,
            power_watts: None,
            power_limit_watts: None,
            clock_mhz: None,
            memory_clock_mhz: None,
            fan_speed_percent: None,
            engine_3d_percent: 0.0,
            engine_copy_percent: 0.0,
            engine_video_encode_percent: 0.0,
            engine_video_decode_percent: 0.0,
            driver_version: reg_driver_version.clone(),
            driver_date: reg_driver_date.clone(),
            pci_location: None,
            available: !dxgi_name.is_empty() || has_nvml,
        };

        #[cfg(windows)]
        let pdh = open_persistent_gpu_pdh();

        let mut collector = Self {
            dxgi_name,
            dxgi_vendor,
            dxgi_vram_total,
            dxgi_shared_total,
            primary_luid_tag,
            reg_driver_version,
            reg_driver_date,
            tick_counter: 0,
            cached: initial,
            cached_per_pid: HashMap::new(),
            #[cfg(windows)]
            nvml: nvml_client,
            #[cfg(windows)]
            pdh,
            #[cfg(windows)]
            pdh_buffer: Vec::new(),
        };
        let _ = collector.refresh();
        collector
    }

    pub fn refresh(&mut self) -> (GpuMetrics, HashMap<u32, f32>) {
        self.tick_counter += 1;

        #[cfg(windows)]
        let has_nvml = self.nvml.is_some();
        #[cfg(not(windows))]
        let has_nvml = false;

        // Collect fast persistent PDH per-process GPU engine usage, engine breakdown & adapter memory
        #[cfg(windows)]
        if let Some(ref pdh) = self.pdh {
            if let Some(sample) = collect_pdh_gpu_sample(
                pdh,
                self.primary_luid_tag.as_deref(),
                &mut self.pdh_buffer,
            ) {
                self.cached_per_pid = sample.per_pid;
                self.cached.engine_3d_percent = sample.engine_3d;
                self.cached.engine_copy_percent = sample.engine_copy;
                self.cached.engine_video_encode_percent = sample.engine_video_encode;
                self.cached.engine_video_decode_percent = sample.engine_video_decode;

                if let Some(shared) = sample.shared_used_bytes {
                    self.cached.shared_used_bytes = shared;
                }
                if !has_nvml {
                    self.cached.usage_percent = Some(sample.overall_percent);
                    if let Some(ded) = sample.dedicated_used_bytes {
                        self.cached.vram_used_bytes = ded;
                    }
                }
            }
        }

        // Poll NVML directly in-process every 2 ticks for VRAM, Temp, Power, Clocks, Fan & Utilization
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
                    self.cached.power_limit_watts = sample.power_limit_watts;
                    self.cached.clock_mhz = sample.clock_mhz;
                    self.cached.memory_clock_mhz = sample.memory_clock_mhz;
                    self.cached.fan_speed_percent = sample.fan_speed_percent;
                    if sample.pci_location.is_some() {
                        self.cached.pci_location = sample.pci_location;
                    }
                    // Prefer Windows WDDM registry version (e.g. 32.0.15.9186), fall back to NVML version
                    if self.reg_driver_version.is_none() && sample.driver_version.is_some() {
                        self.cached.driver_version = sample.driver_version;
                    }
                    self.cached.available = true;
                }
            }

            if self.cached.name.is_empty() && !self.dxgi_name.is_empty() {
                self.cached.name = self.dxgi_name.clone();
                self.cached.vendor = self.dxgi_vendor.clone();
                self.cached.vram_total_bytes = self.dxgi_vram_total;
                self.cached.shared_total_bytes = self.dxgi_shared_total;
                self.cached.available = true;
            }
            if self.cached.driver_version.is_none() {
                self.cached.driver_version = self.reg_driver_version.clone();
            }
            if self.cached.driver_date.is_none() {
                self.cached.driver_date = self.reg_driver_date.clone();
            }
        }

        (self.cached.clone(), self.cached_per_pid.clone())
    }
}

#[cfg(windows)]
fn query_dxgi_primary_adapter() -> (String, String, u64, u64, Option<String>) {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};

    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
            return (String::new(), "Unknown".to_string(), 0, 0, None);
        };

        let mut best_name = String::new();
        let mut best_vendor = "Unknown".to_string();
        let mut best_vram: u64 = 0;
        let mut best_shared: u64 = 0;
        let mut best_luid: Option<String> = None;

        let mut idx = 0;
        while let Ok(adapter) = factory.EnumAdapters1(idx) {
            idx += 1;
            if let Ok(desc) = adapter.GetDesc1() {
                if (desc.Flags & 2) != 0 {
                    continue;
                }
                let vram = desc.DedicatedVideoMemory as u64;
                let shared = desc.SharedSystemMemory as u64;
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
                    best_shared = shared;
                    best_luid = Some(
                        format!(
                            "luid_0x{:08x}_0x{:08x}",
                            desc.AdapterLuid.HighPart as u32, desc.AdapterLuid.LowPart
                        )
                        .to_lowercase(),
                    );
                }
            }
        }
        (best_name, best_vendor, best_vram, best_shared, best_luid)
    }
}

#[cfg(not(windows))]
fn query_dxgi_primary_adapter() -> (String, String, u64, u64, Option<String>) {
    (String::new(), "Unknown".to_string(), 0, 0, None)
}

#[cfg(windows)]
fn query_gpu_driver_registry(adapter_name: &str) -> (Option<String>, Option<String>) {
    use windows::core::{w, PCWSTR, PWSTR};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE,
        KEY_READ, REG_SZ,
    };

    if adapter_name.is_empty() {
        return (None, None);
    }

    let target_lower = adapter_name.to_lowercase();

    unsafe {
        let mut class_key = HKEY::default();
        let class_path =
            w!("SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}");
        if RegOpenKeyExW(HKEY_LOCAL_MACHINE, class_path, Some(0), KEY_READ, &mut class_key).is_err() {
            return (None, None);
        }

        let read_reg_sz = |key: HKEY, name: PCWSTR| -> Option<String> {
            let mut value_type = REG_SZ;
            let mut buf = [0u16; 256];
            let mut byte_len = (buf.len() * 2) as u32;
            if RegQueryValueExW(
                key,
                name,
                None,
                Some(&mut value_type),
                Some(buf.as_mut_ptr() as *mut u8),
                Some(&mut byte_len),
            )
            .is_ok()
                && value_type == REG_SZ
            {
                let u16_len = (byte_len as usize / 2).min(buf.len());
                let slice = &buf[..u16_len];
                let end = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());
                let s = String::from_utf16_lossy(&slice[..end]).trim().to_string();
                if !s.is_empty() {
                    return Some(s);
                }
            }
            None
        };

        let mut result = (None, None);
        let mut index = 0u32;
        loop {
            let mut name_buf = [0u16; 64];
            let mut name_len = name_buf.len() as u32;
            let status = RegEnumKeyExW(
                class_key,
                index,
                Some(PWSTR(name_buf.as_mut_ptr())),
                &mut name_len,
                None,
                None,
                None,
                None,
            );
            if status.is_err() {
                break;
            }
            index += 1;

            let sub_name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
            if sub_name.len() != 4 || !sub_name.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }

            let mut sub_wide: Vec<u16> = sub_name.encode_utf16().collect();
            sub_wide.push(0);
            let mut sub_key = HKEY::default();
            if RegOpenKeyExW(
                class_key,
                PCWSTR(sub_wide.as_ptr()),
                Some(0),
                KEY_READ,
                &mut sub_key,
            )
            .is_ok()
            {
                let desc = read_reg_sz(sub_key, w!("DriverDesc")).unwrap_or_default();
                let desc_lower = desc.to_lowercase();
                if !desc_lower.is_empty()
                    && (desc_lower == target_lower
                        || desc_lower.contains(&target_lower)
                        || target_lower.contains(&desc_lower))
                {
                    let ver = read_reg_sz(sub_key, w!("DriverVersion"));
                    let raw_date = read_reg_sz(sub_key, w!("DriverDate"));
                    let fmt_date = raw_date.map(|d| format_driver_date_de(&d));
                    result = (ver, fmt_date);
                    let _ = RegCloseKey(sub_key);
                    break;
                }
                let _ = RegCloseKey(sub_key);
            }
        }

        let _ = RegCloseKey(class_key);
        result
    }
}

#[cfg(windows)]
fn format_driver_date_de(raw: &str) -> String {
    // Registry stores DriverDate as "MM-DD-YYYY" or "M-D-YYYY"
    let parts: Vec<&str> = raw.trim().split('-').collect();
    if parts.len() == 3 {
        if let (Ok(m), Ok(d), Ok(y)) = (
            parts[0].parse::<u32>(),
            parts[1].parse::<u32>(),
            parts[2].parse::<u32>(),
        ) {
            return format!("{:02}.{:02}.{:04}", d, m, y);
        }
    }
    raw.to_string()
}

#[cfg(not(windows))]
fn query_gpu_driver_registry(_adapter_name: &str) -> (Option<String>, Option<String>) {
    (None, None)
}

#[cfg(windows)]
fn open_persistent_gpu_pdh() -> Option<GpuPdhHandles> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhOpenQueryW, PDH_HCOUNTER,
        PDH_HQUERY,
    };

    unsafe {
        let mut query = PDH_HQUERY::default();
        if PdhOpenQueryW(None, 0, &mut query) != 0 {
            return None;
        }
        let add = |path: PCWSTR| -> Option<PDH_HCOUNTER> {
            let mut c = PDH_HCOUNTER::default();
            if PdhAddEnglishCounterW(query, path, 0, &mut c) == 0 {
                Some(c)
            } else {
                None
            }
        };

        let Some(engine_counter) = add(w!("\\GPU Engine(*)\\Utilization Percentage")) else {
            let _ = PdhCloseQuery(query);
            return None;
        };
        let dedicated_mem_counter = add(w!("\\GPU Adapter Memory(*)\\Dedicated Usage"));
        let shared_mem_counter = add(w!("\\GPU Adapter Memory(*)\\Shared Usage"));

        // Prime initial baseline sample
        let _ = PdhCollectQueryData(query);
        Some(GpuPdhHandles {
            query,
            engine_counter,
            dedicated_mem_counter,
            shared_mem_counter,
        })
    }
}

#[cfg(windows)]
fn read_pdh_array(
    counter: windows::Win32::System::Performance::PDH_HCOUNTER,
    buffer: &mut Vec<u8>,
) -> Vec<(String, f64)> {
    use windows::Win32::System::Performance::{
        PdhGetFormattedCounterArrayW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE,
    };

    unsafe {
        let mut buf_size: u32 = 0;
        let mut item_count: u32 = 0;
        let _ = PdhGetFormattedCounterArrayW(
            counter,
            PDH_FMT_DOUBLE,
            &mut buf_size,
            &mut item_count,
            None,
        );
        if buf_size == 0 || item_count == 0 {
            return Vec::new();
        }
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
        ) != 0
        {
            return Vec::new();
        }

        let items = std::slice::from_raw_parts(items_ptr, item_count as usize);
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            let val = item.FmtValue.Anonymous.doubleValue;
            if !val.is_finite() {
                continue;
            }
            let name = item.szName.to_string().unwrap_or_default();
            out.push((name, val));
        }
        out
    }
}

#[cfg(windows)]
fn collect_pdh_gpu_sample(
    pdh: &GpuPdhHandles,
    primary_luid: Option<&str>,
    buffer: &mut Vec<u8>,
) -> Option<GpuPdhSample> {
    use windows::Win32::System::Performance::PdhCollectQueryData;

    unsafe {
        if PdhCollectQueryData(pdh.query) != 0 {
            return None;
        }
    }

    let engine_items = read_pdh_array(pdh.engine_counter, buffer);
    let mut per_pid: HashMap<u32, f32> = HashMap::new();
    let mut engine_totals_primary: HashMap<String, f32> = HashMap::new();
    let mut engine_totals_all: HashMap<String, f32> = HashMap::new();
    let mut matched_primary_luid = false;

    for (name, val) in engine_items {
        if val <= 0.01 {
            continue;
        }
        let v = (val as f32).clamp(0.0, 100.0);
        let lower = name.to_lowercase();

        // Parse "pid_12345_luid_..."
        if let Some(rest) = lower.strip_prefix("pid_") {
            if let Some(pid_str) = rest.split('_').next() {
                if let Ok(pid) = pid_str.parse::<u32>() {
                    let entry = per_pid.entry(pid).or_insert(0.0);
                    *entry = (*entry + v).min(100.0);
                }
            }
        }

        if let Some(idx) = lower.find("engtype_") {
            let eng_key = &lower[idx..];
            let e_all = engine_totals_all.entry(eng_key.to_string()).or_insert(0.0);
            *e_all = (*e_all + v).min(100.0);

            if let Some(luid) = primary_luid {
                if lower.contains(luid) {
                    matched_primary_luid = true;
                    let e_pri = engine_totals_primary
                        .entry(eng_key.to_string())
                        .or_insert(0.0);
                    *e_pri = (*e_pri + v).min(100.0);
                }
            }
        }
    }

    for v in per_pid.values_mut() {
        *v = (*v * 10.0).round() / 10.0;
    }

    let eng_map = if matched_primary_luid {
        &engine_totals_primary
    } else {
        &engine_totals_all
    };

    let mut engine_3d = 0.0f32;
    let mut engine_copy = 0.0f32;
    let mut engine_video_encode = 0.0f32;
    let mut engine_video_decode = 0.0f32;
    let mut overall = 0.0f32;

    for (k, &v) in eng_map {
        overall = overall.max(v);
        if k == "engtype_3d" || k.starts_with("engtype_3d") {
            engine_3d = engine_3d.max(v);
        } else if k.starts_with("engtype_copy") {
            engine_copy = engine_copy.max(v);
        } else if k.starts_with("engtype_videoencode") {
            engine_video_encode = engine_video_encode.max(v);
        } else if k.starts_with("engtype_videodecode") || k.starts_with("engtype_videoprocessing") {
            engine_video_decode = engine_video_decode.max(v);
        }
    }

    let pick_adapter_mem =
        |counter: Option<windows::Win32::System::Performance::PDH_HCOUNTER>,
         buf: &mut Vec<u8>|
         -> Option<u64> {
        let c = counter?;
        let items = read_pdh_array(c, buf);
        let mut primary_val: Option<u64> = None;
        let mut fallback_max: Option<u64> = None;
        for (name, val) in items {
            if val < 0.0 {
                continue;
            }
            let bytes = val.round() as u64;
            let lower = name.to_lowercase();
            if let Some(luid) = primary_luid {
                if lower.contains(luid) {
                    primary_val = Some(primary_val.map_or(bytes, |p| p.max(bytes)));
                }
            }
            fallback_max = Some(fallback_max.map_or(bytes, |p| p.max(bytes)));
        }
        primary_val.or(fallback_max)
    };

    let dedicated_used_bytes = pick_adapter_mem(pdh.dedicated_mem_counter, buffer);
    let shared_used_bytes = pick_adapter_mem(pdh.shared_mem_counter, buffer);

    let round1 = |x: f32| (x.clamp(0.0, 100.0) * 10.0).round() / 10.0;

    Some(GpuPdhSample {
        overall_percent: round1(overall),
        engine_3d: round1(engine_3d),
        engine_copy: round1(engine_copy),
        engine_video_encode: round1(engine_video_encode),
        engine_video_decode: round1(engine_video_decode),
        dedicated_used_bytes,
        shared_used_bytes,
        per_pid,
    })
}
