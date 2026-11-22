//! Native Windows CPU telemetry collector:
//! 1. Real effective/Turbo CPU clock (total + per-core) via PDH `% Processor Performance` * `Processor Frequency`
//! 2. Native CPU Package Power (Watts) via Windows Energy Metering Interface (EMI / RAPL) and PDH Power Meter
//! 3. Native ACPI Thermal Zone temperature via PDH (`High Precision Temperature` / `Temperature`)
//! 4. Automatic zero-overhead integration with HWiNFO64 Shared Memory (`Global\HWiNFO_SENS_SM2`)
//!    and LibreHardwareMonitor / OpenHardwareMonitor WMI when running in the background.

#[derive(Debug, Clone, Default)]
pub struct CpuSensorReading {
    pub effective_freq_mhz: Option<u64>,
    pub base_freq_mhz: Option<u64>,
    pub per_core_freq_mhz: Vec<u64>,
    pub temperature_c: Option<f32>,
    pub power_watts: Option<f32>,
    pub sensor_source: Option<String>,
}

#[cfg(not(windows))]
pub struct CpuSensorCollector;

#[cfg(not(windows))]
impl CpuSensorCollector {
    pub fn new() -> Self {
        Self
    }
    pub fn sample(&mut self, _fallback_base_mhz: u64, _logical_cores: usize) -> CpuSensorReading {
        CpuSensorReading::default()
    }
}

#[cfg(windows)]
mod win_impl {
    use super::CpuSensorReading;
    use std::collections::HashMap;
    use std::ffi::c_void;
    use windows::core::{w, BSTR, GUID, PCWSTR};
    use windows::Win32::Devices::DeviceAndDriverInstallation::{
        CM_Get_Device_Interface_ListW, CM_Get_Device_Interface_List_SizeW,
        CM_GET_DEVICE_INTERFACE_LIST_PRESENT, CR_SUCCESS,
    };
    use windows::Win32::Foundation::{
        CloseHandle, HANDLE, INVALID_HANDLE_VALUE, RPC_E_CHANGED_MODE, WAIT_OBJECT_0,
    };
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_EXISTING,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoSetProxyBlanket, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED, EOAC_NONE, RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE,
    };
    use windows::Win32::System::IO::DeviceIoControl;
    use windows::Win32::System::Memory::{
        MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_READ,
    };
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
        PdhGetFormattedCounterValue, PdhOpenQueryW, PDH_FMT_COUNTERVALUE,
        PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
    };
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::System::Power::{
        EMI_CHANNEL_MEASUREMENT_DATA, EMI_METADATA_SIZE, EMI_VERSION, EMI_VERSION_V1,
        EMI_VERSION_V2, GUID_DEVICE_ENERGY_METER, IOCTL_EMI_GET_MEASUREMENT,
        IOCTL_EMI_GET_METADATA, IOCTL_EMI_GET_METADATA_SIZE, IOCTL_EMI_GET_VERSION,
    };
    use windows::Win32::System::Threading::{
        OpenMutexW, ReleaseMutex, WaitForSingleObject, SYNCHRONIZATION_ACCESS_RIGHTS,
    };
    use windows::Win32::System::Wmi::{
        IWbemLocator, IWbemServices, WbemLocator, WBEM_FLAG_FORWARD_ONLY,
        WBEM_FLAG_RETURN_IMMEDIATELY, WBEM_INFINITE,
    };

    // -------------------------------------------------------------------------
    // 1. PDH Collector: Real Turbo CPU Clock, Per-Core Clocks, Thermal Zone, Power Meter
    // -------------------------------------------------------------------------
    struct PdhCpuCounters {
        query: PDH_HQUERY,
        total_perf: Option<PDH_HCOUNTER>,
        total_base_freq: Option<PDH_HCOUNTER>,
        per_core_perf: Option<PDH_HCOUNTER>,
        per_core_base_freq: Option<PDH_HCOUNTER>,
        thermal_hi_prec: Option<PDH_HCOUNTER>,
        thermal_std: Option<PDH_HCOUNTER>,
        power_meter: Option<PDH_HCOUNTER>,
        array_buf: Vec<u8>,
        cached_base_mhz: u64,
        cached_per_core_base: HashMap<(u32, u32), u64>,
        acpi_first_temp: Option<f32>,
        acpi_temp_has_changed: bool,
        acpi_static_ticks: u32,
    }

    unsafe impl Send for PdhCpuCounters {}

    impl Drop for PdhCpuCounters {
        fn drop(&mut self) {
            unsafe {
                let _ = PdhCloseQuery(self.query);
            }
        }
    }

    impl PdhCpuCounters {
        fn open() -> Option<Self> {
            unsafe {
                let mut query = PDH_HQUERY::default();
                if PdhOpenQueryW(None, 0, &mut query) != 0 {
                    return None;
                }

                let add = |path: PCWSTR| -> Option<PDH_HCOUNTER> {
                    let mut counter = PDH_HCOUNTER::default();
                    if PdhAddEnglishCounterW(query, path, 0, &mut counter) == 0 {
                        Some(counter)
                    } else {
                        None
                    }
                };

                let total_perf =
                    add(w!("\\Processor Information(_Total)\\% Processor Performance"));
                let total_base_freq =
                    add(w!("\\Processor Information(_Total)\\Processor Frequency"));
                let per_core_perf =
                    add(w!("\\Processor Information(*)\\% Processor Performance"));
                let per_core_base_freq =
                    add(w!("\\Processor Information(*)\\Processor Frequency"));
                let thermal_hi_prec =
                    add(w!("\\Thermal Zone Information(*)\\High Precision Temperature"));
                let thermal_std = if thermal_hi_prec.is_none() {
                    add(w!("\\Thermal Zone Information(*)\\Temperature"))
                } else {
                    None
                };
                let power_meter = add(w!("\\Power Meter(*)\\Power"));

                if total_perf.is_none()
                    && total_base_freq.is_none()
                    && thermal_hi_prec.is_none()
                    && thermal_std.is_none()
                    && power_meter.is_none()
                {
                    let _ = PdhCloseQuery(query);
                    return None;
                }

                // Prime baseline sample (PDH rate/perf counters need 2 samples)
                let _ = PdhCollectQueryData(query);

                Some(Self {
                    query,
                    total_perf,
                    total_base_freq,
                    per_core_perf,
                    per_core_base_freq,
                    thermal_hi_prec,
                    thermal_std,
                    power_meter,
                    array_buf: Vec::new(),
                    cached_base_mhz: 0,
                    cached_per_core_base: HashMap::new(),
                    acpi_first_temp: None,
                    acpi_temp_has_changed: false,
                    acpi_static_ticks: 0,
                })
            }
        }

        fn read_scalar(&self, counter: PDH_HCOUNTER) -> Option<f64> {
            unsafe {
                let mut val = PDH_FMT_COUNTERVALUE::default();
                if PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE, None, &mut val) == 0 {
                    let d = val.Anonymous.doubleValue;
                    if d.is_finite() {
                        return Some(d);
                    }
                }
                None
            }
        }

        fn read_array(&mut self, counter: PDH_HCOUNTER) -> Vec<(String, f64)> {
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
                if self.array_buf.len() < needed {
                    self.array_buf.resize(needed, 0);
                }
                let items_ptr = self.array_buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
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
                    let d = item.FmtValue.Anonymous.doubleValue;
                    if !d.is_finite() {
                        continue;
                    }
                    let name = item.szName.to_string().unwrap_or_default();
                    out.push((name, d));
                }
                out
            }
        }

        fn sample(
            &mut self,
            fallback_base_mhz: u64,
            logical_cores: usize,
        ) -> (Option<u64>, Option<u64>, Vec<u64>, Option<f32>, Option<f32>) {
            unsafe {
                if PdhCollectQueryData(self.query) != 0 {
                    return (None, None, Vec::new(), None, None);
                }
            }

            // Nominal base frequency (refresh once if 0)
            if self.cached_base_mhz == 0 {
                if let Some(c) = self.total_base_freq {
                    if let Some(mhz) = self.read_scalar(c) {
                        if mhz >= 400.0 && mhz <= 9000.0 {
                            self.cached_base_mhz = mhz.round() as u64;
                        }
                    }
                }
            }
            let base_mhz = if self.cached_base_mhz > 0 {
                self.cached_base_mhz
            } else {
                fallback_base_mhz
            };

            // Cache per-core nominal base frequencies once
            if self.cached_per_core_base.is_empty() {
                if let Some(c) = self.per_core_base_freq {
                    for (name, val) in self.read_array(c) {
                        if let Some(key) = parse_core_instance(&name) {
                            if val >= 400.0 && val <= 9000.0 {
                                self.cached_per_core_base.insert(key, val.round() as u64);
                            }
                        }
                    }
                }
            }

            // Real effective total CPU clock = Base * (% Processor Performance / 100)
            let effective_mhz = self.total_perf.and_then(|c| self.read_scalar(c)).and_then(|pct| {
                if pct > 1.0 && base_mhz > 0 {
                    let mhz = (base_mhz as f64 * (pct / 100.0)).round() as u64;
                    if (300..=10000).contains(&mhz) {
                        return Some(mhz);
                    }
                }
                None
            });

            // Per-core real effective clocks sorted by (processor_group, core_index)
            let mut per_core_freq_mhz = Vec::new();
            if let Some(c) = self.per_core_perf {
                let mut core_entries: Vec<((u32, u32), u64)> = Vec::with_capacity(logical_cores);
                for (name, pct) in self.read_array(c) {
                    if let Some(key) = parse_core_instance(&name) {
                        let core_base = self
                            .cached_per_core_base
                            .get(&key)
                            .copied()
                            .unwrap_or(base_mhz);
                        let mhz = if pct > 1.0 && core_base > 0 {
                            ((core_base as f64 * (pct / 100.0)).round() as u64).clamp(300, 10000)
                        } else {
                            core_base
                        };
                        core_entries.push((key, mhz));
                    }
                }
                if !core_entries.is_empty() {
                    core_entries.sort_by_key(|(k, _)| *k);
                    per_core_freq_mhz = core_entries.into_iter().map(|(_, f)| f).collect();
                }
            }

            // ACPI Thermal Zone Temperature (PDH reports Kelvin or deci-Kelvin).
            // Desktop motherboards commonly ship a hardcoded BIOS ACPI stub (e.g. 301.0K = 27.85°C)
            // that never changes under load. Filter known stub values and frozen readings!
            let mut thermal_temp: Option<f32> = None;
            let thermal_counter = self.thermal_hi_prec.or(self.thermal_std);
            if let Some(c) = thermal_counter {
                let mut best_priority = 0u8;
                let mut best_val: Option<f32> = None;
                for (name, raw) in self.read_array(c) {
                    let celsius = if (2500.0..=4500.0).contains(&raw) {
                        // Tenths of Kelvin (deci-Kelvin)
                        (raw / 10.0) - 273.15
                    } else if (274.0..=420.0).contains(&raw) {
                        // Whole Kelvin
                        raw - 273.15
                    } else {
                        continue;
                    };
                    if !(10.0..=120.0).contains(&celsius) || is_acpi_dummy_celsius(celsius as f32) {
                        continue;
                    }
                    let lower = name.to_lowercase();
                    let prio = if lower.contains("cpu") || lower.contains("pkg") || lower.contains("proc") {
                        3
                    } else if lower.contains("tz0") || lower.contains("thm") || lower.contains("acpi") {
                        2
                    } else {
                        1
                    };
                    let c_f32 = (celsius * 10.0).round() as f32 / 10.0;
                    if prio > best_priority
                        || (prio == best_priority && best_val.map_or(true, |prev| c_f32 > prev))
                    {
                        best_priority = prio;
                        best_val = Some(c_f32);
                    }
                }
                if let Some(val) = best_val {
                    match self.acpi_first_temp {
                        None => {
                            self.acpi_first_temp = Some(val);
                            self.acpi_static_ticks = 1;
                        }
                        Some(first) => {
                            if (val - first).abs() >= 0.4 {
                                self.acpi_temp_has_changed = true;
                            } else {
                                self.acpi_static_ticks = self.acpi_static_ticks.saturating_add(1);
                            }
                        }
                    }
                    // Suppress suspiciously low/frozen ACPI readings that never move across ticks
                    let looks_frozen_stub = !self.acpi_temp_has_changed
                        && ((val <= 33.0 && self.acpi_static_ticks >= 3)
                            || self.acpi_static_ticks >= 15);
                    if !looks_frozen_stub {
                        thermal_temp = Some(val);
                    }
                }
            }

            // Windows PDH Power Meter (milliwatts -> Watts)
            let mut power_meter_watts: Option<f32> = None;
            if let Some(c) = self.power_meter {
                let mut best_prio = 0u8;
                let mut best_w: Option<f32> = None;
                for (name, mw) in self.read_array(c) {
                    if !mw.is_finite() || mw <= 100.0 {
                        continue;
                    }
                    let watts = (mw / 1000.0) as f32;
                    if !(0.2..=600.0).contains(&watts) {
                        continue;
                    }
                    let lower = name.to_lowercase();
                    if lower.contains("gpu") || lower.contains("battery") || lower.contains("display") {
                        continue;
                    }
                    let prio = if lower.contains("cpu") || lower.contains("pkg") || lower.contains("proc") {
                        3
                    } else if lower.contains("rapl") || lower.contains("soc") {
                        2
                    } else {
                        1
                    };
                    let rounded = (watts * 10.0).round() / 10.0;
                    if prio > best_prio {
                        best_prio = prio;
                        best_w = Some(rounded);
                    }
                }
                power_meter_watts = best_w;
            }

            (
                effective_mhz,
                if base_mhz > 0 { Some(base_mhz) } else { None },
                per_core_freq_mhz,
                thermal_temp,
                power_meter_watts,
            )
        }
    }

    fn parse_core_instance(name: &str) -> Option<(u32, u32)> {
        if name.contains("_Total") {
            return None;
        }
        let mut parts = name.split(',');
        let group = parts.next()?.trim().parse::<u32>().ok()?;
        let core = parts.next()?.trim().parse::<u32>().ok()?;
        Some((group, core))
    }

    // -------------------------------------------------------------------------
    // 2. Windows Energy Metering Interface (EMI / RAPL) — Native CPU Package Power
    // -------------------------------------------------------------------------
    struct EmiDevice {
        handle: HANDLE,
        version: u16,
        selected_channels: Vec<usize>,
        prev_samples: Vec<(u64, u64)>, // (absolute_energy_pwh, absolute_time_100ns)
        measure_buf: Vec<u8>,
    }

    // SAFETY: Accessed exclusively on the single telemetry worker thread via Mutex<Option<TelemetryEngine>>.
    unsafe impl Send for EmiDevice {}

    impl Drop for EmiDevice {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }

    struct EmiCollector {
        devices: Vec<EmiDevice>,
    }

    impl EmiCollector {
        fn discover() -> Self {
            let mut devices = Vec::new();
            let paths = enumerate_device_interfaces(&GUID_DEVICE_ENERGY_METER);
            for path in paths {
                if let Some(dev) = open_emi_device(&path) {
                    devices.push(dev);
                }
            }
            Self { devices }
        }

        fn sample_cpu_watts(&mut self) -> Option<f32> {
            if self.devices.is_empty() {
                return None;
            }

            let mut total_watts = 0.0f64;
            let mut got_reading = false;

            for dev in &mut self.devices {
                if let Some(w) = dev.sample_watts() {
                    total_watts += w;
                    got_reading = true;
                }
            }

            if got_reading && (0.1..=600.0).contains(&total_watts) {
                Some(((total_watts as f32) * 10.0).round() / 10.0)
            } else {
                None
            }
        }
    }

    impl EmiDevice {
        fn sample_watts(&mut self) -> Option<f64> {
            unsafe {
                let mut bytes_ret = 0u32;
                let ok = DeviceIoControl(
                    self.handle,
                    IOCTL_EMI_GET_MEASUREMENT,
                    None,
                    0,
                    Some(self.measure_buf.as_mut_ptr() as *mut c_void),
                    self.measure_buf.len() as u32,
                    Some(&mut bytes_ret),
                    None,
                )
                .is_ok();

                if !ok {
                    return None;
                }

                let mut sum_watts = 0.0f64;
                let mut any = false;

                if self.version == EMI_VERSION_V1 as u16 {
                    if (bytes_ret as usize) < std::mem::size_of::<EMI_CHANNEL_MEASUREMENT_DATA>() {
                        return None;
                    }
                    let data = std::ptr::read_unaligned(
                        self.measure_buf.as_ptr() as *const EMI_CHANNEL_MEASUREMENT_DATA
                    );
                    let cur = (data.AbsoluteEnergy, data.AbsoluteTime);
                    let prev = self.prev_samples[0];
                    self.prev_samples[0] = cur;
                    if prev.1 > 0 && cur.1 > prev.1 {
                        let d_energy = cur.0.wrapping_sub(prev.0);
                        let d_time = cur.1.saturating_sub(prev.1);
                        if d_time >= 100_000 {
                            let w = (d_energy as f64 * 3600.0) / (d_time as f64 * 1e5);
                            if (0.0..=600.0).contains(&w) {
                                sum_watts += w;
                                any = true;
                            }
                        }
                    }
                } else {
                    let elem_size = std::mem::size_of::<EMI_CHANNEL_MEASUREMENT_DATA>();
                    let max_channels = (bytes_ret as usize) / elem_size;
                    for &ch in &self.selected_channels {
                        if ch >= max_channels || ch >= self.prev_samples.len() {
                            continue;
                        }
                        let ptr = self
                            .measure_buf
                            .as_ptr()
                            .add(ch * elem_size)
                            as *const EMI_CHANNEL_MEASUREMENT_DATA;
                        let data = std::ptr::read_unaligned(ptr);
                        let cur = (data.AbsoluteEnergy, data.AbsoluteTime);
                        let prev = self.prev_samples[ch];
                        self.prev_samples[ch] = cur;
                        if prev.1 > 0 && cur.1 > prev.1 {
                            let d_energy = cur.0.wrapping_sub(prev.0);
                            let d_time = cur.1.saturating_sub(prev.1);
                            if d_time >= 100_000 {
                                let w = (d_energy as f64 * 3600.0) / (d_time as f64 * 1e5);
                                if (0.0..=600.0).contains(&w) {
                                    sum_watts += w;
                                    any = true;
                                }
                            }
                        }
                    }
                }

                if any { Some(sum_watts) } else { None }
            }
        }
    }

    fn enumerate_device_interfaces(guid: &GUID) -> Vec<String> {
        unsafe {
            let mut len = 0u32;
            if CM_Get_Device_Interface_List_SizeW(
                &mut len,
                guid,
                PCWSTR::null(),
                CM_GET_DEVICE_INTERFACE_LIST_PRESENT,
            ) != CR_SUCCESS
                || len <= 1
            {
                return Vec::new();
            }

            let mut buf = vec![0u16; len as usize];
            if CM_Get_Device_Interface_ListW(
                guid,
                PCWSTR::null(),
                &mut buf,
                CM_GET_DEVICE_INTERFACE_LIST_PRESENT,
            ) != CR_SUCCESS
            {
                return Vec::new();
            }

            let mut out = Vec::new();
            let mut start = 0usize;
            while start < buf.len() {
                let slice = &buf[start..];
                let Some(pos) = slice.iter().position(|&c| c == 0) else {
                    break;
                };
                if pos == 0 {
                    break;
                }
                out.push(String::from_utf16_lossy(&slice[..pos]));
                start += pos + 1;
            }
            out
        }
    }

    fn open_emi_device(path: &str) -> Option<EmiDevice> {
        unsafe {
            let mut wide: Vec<u16> = path.encode_utf16().collect();
            wide.push(0);
            let handle = CreateFileW(
                PCWSTR(wide.as_ptr()),
                FILE_GENERIC_READ.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
            .ok()?;

            if handle.is_invalid() || handle == INVALID_HANDLE_VALUE {
                return None;
            }

            // 1. Query EMI Version
            let mut ver = EMI_VERSION::default();
            let mut ret = 0u32;
            let ver_ok = DeviceIoControl(
                handle,
                IOCTL_EMI_GET_VERSION,
                None,
                0,
                Some(&mut ver as *mut _ as *mut c_void),
                std::mem::size_of::<EMI_VERSION>() as u32,
                Some(&mut ret),
                None,
            )
            .is_ok();

            if !ver_ok || (ver.EmiVersion != EMI_VERSION_V1 as u16 && ver.EmiVersion != EMI_VERSION_V2 as u16) {
                let _ = CloseHandle(handle);
                return None;
            }

            // 2. Query Metadata size
            let mut meta_size = EMI_METADATA_SIZE::default();
            let sz_ok = DeviceIoControl(
                handle,
                IOCTL_EMI_GET_METADATA_SIZE,
                None,
                0,
                Some(&mut meta_size as *mut _ as *mut c_void),
                std::mem::size_of::<EMI_METADATA_SIZE>() as u32,
                Some(&mut ret),
                None,
            )
            .is_ok();

            if !sz_ok || meta_size.MetadataSize == 0 || meta_size.MetadataSize > 1024 * 1024 {
                let _ = CloseHandle(handle);
                return None;
            }

            // 3. Query Metadata
            let mut meta_buf = vec![0u8; meta_size.MetadataSize as usize];
            let meta_ok = DeviceIoControl(
                handle,
                IOCTL_EMI_GET_METADATA,
                None,
                0,
                Some(meta_buf.as_mut_ptr() as *mut c_void),
                meta_buf.len() as u32,
                Some(&mut ret),
                None,
            )
            .is_ok();

            if !meta_ok {
                let _ = CloseHandle(handle);
                return None;
            }

            // 4. Identify CPU Package channel(s)
            let (channel_count, selected_channels) = if ver.EmiVersion == EMI_VERSION_V1 as u16 {
                // V1 has 1 channel; check if MeteredHardwareName looks like CPU/RAPL/PKG
                let name = extract_utf16_strings_from_bytes(&meta_buf).to_lowercase();
                if is_cpu_power_channel(&name) > 0 {
                    (1usize, vec![0usize])
                } else {
                    let _ = CloseHandle(handle);
                    return None;
                }
            } else {
                // EMI_METADATA_V2 layout:
                // HardwareOEM[16] (32B) + HardwareModel[16] (32B) + HardwareRevision (2B) + ChannelCount (2B) = 68 bytes
                if meta_buf.len() < 68 {
                    let _ = CloseHandle(handle);
                    return None;
                }
                let ch_count =
                    u16::from_le_bytes([meta_buf[66], meta_buf[67]]) as usize;
                if ch_count == 0 || ch_count > 128 {
                    let _ = CloseHandle(handle);
                    return None;
                }

                let mut channel_names: Vec<String> = Vec::with_capacity(ch_count);
                let mut offset = 68usize;
                for _ in 0..ch_count {
                    // EMI_CHANNEL_V2: MeasurementUnit (4B) + ChannelNameSize (2B) + ChannelName[ChannelNameSize bytes]
                    if offset + 6 > meta_buf.len() {
                        break;
                    }
                    let name_size_bytes =
                        u16::from_le_bytes([meta_buf[offset + 4], meta_buf[offset + 5]]) as usize;
                    let name_start = offset + 6;
                    let name_end = (name_start + name_size_bytes).min(meta_buf.len());
                    let u16_len = (name_end.saturating_sub(name_start)) / 2;
                    let mut chars = Vec::with_capacity(u16_len);
                    for i in 0..u16_len {
                        let lo = meta_buf[name_start + i * 2];
                        let hi = meta_buf[name_start + i * 2 + 1];
                        let ch = u16::from_le_bytes([lo, hi]);
                        if ch == 0 {
                            break;
                        }
                        chars.push(ch);
                    }
                    channel_names.push(String::from_utf16_lossy(&chars));
                    if name_size_bytes == 0 {
                        break;
                    }
                    offset = name_start + name_size_bytes;
                }

                // Pick highest-priority CPU channels (e.g., all RAPL_Package*_PKG channels)
                let mut best_prio = 0u8;
                let mut scored: Vec<(usize, u8)> = Vec::new();
                for (idx, name) in channel_names.iter().enumerate() {
                    let prio = is_cpu_power_channel(&name.to_lowercase());
                    if prio > 0 {
                        if prio > best_prio {
                            best_prio = prio;
                        }
                        scored.push((idx, prio));
                    }
                }
                let picked: Vec<usize> = scored
                    .into_iter()
                    .filter(|(_, p)| *p == best_prio)
                    .map(|(idx, _)| idx)
                    .collect();

                if picked.is_empty() {
                    let _ = CloseHandle(handle);
                    return None;
                }
                (ch_count, picked)
            };

            let measure_len = if ver.EmiVersion == EMI_VERSION_V1 as u16 {
                std::mem::size_of::<EMI_CHANNEL_MEASUREMENT_DATA>()
            } else {
                channel_count * std::mem::size_of::<EMI_CHANNEL_MEASUREMENT_DATA>()
            };

            let mut dev = EmiDevice {
                handle,
                version: ver.EmiVersion,
                selected_channels,
                prev_samples: vec![(0, 0); channel_count.max(1)],
                measure_buf: vec![0u8; measure_len.max(32)],
            };
            // Prime baseline measurement
            let _ = dev.sample_watts();
            Some(dev)
        }
    }

    fn extract_utf16_strings_from_bytes(bytes: &[u8]) -> String {
        let mut out = String::new();
        for chunk in bytes.chunks_exact(2) {
            let v = u16::from_le_bytes([chunk[0], chunk[1]]);
            if (0x20..=0x7E).contains(&v) {
                out.push(v as u8 as char);
            } else if v == 0 {
                out.push(' ');
            }
        }
        out
    }

    pub fn is_acpi_dummy_celsius(c: f32) -> bool {
        // Known hardcoded Intel/AMI/UEFI desktop DSDT ACPI _TMP stub constants:
        // 301.0 K = 27.85°C (0x0BC2 — by far the most common Intel desktop BIOS stub!)
        // 300.0 K = 26.85°C (0x0BB8)
        // 303.0 K = 29.85°C (0x0BD6)
        // 298.2 K = 25.05°C (0x0BA6)
        // 290.0 K = 16.85°C (0x0B54)
        const STUBS: [f32; 5] = [27.85, 26.85, 29.85, 25.05, 16.85];
        STUBS.iter().any(|&stub| (c - stub).abs() < 0.16)
    }

    pub(crate) fn is_cpu_power_channel(name_lower: &str) -> u8 {
        // Exclude non-package / sub-domain / memory / GPU / total-platform channels
        if name_lower.contains("dram")
            || name_lower.contains("dimm")
            || name_lower.contains("pp1")
            || name_lower.contains("gpu")
            || name_lower.contains("gt_")
            || name_lower.contains("psys")
            || name_lower.contains("platform")
            || name_lower.contains("display")
            || name_lower.contains("battery")
        {
            return 0;
        }
        // IMPORTANT: Check PP0 / Cores BEFORE "package"!
        // Windows RAPL EMI names the core sub-domain "RAPL_Package0_PP0", which ALSO contains
        // "package". Giving PP0 lower priority (2) than PKG (4) prevents summing PKG + PP0
        // (which would otherwise double-count CPU wattage!).
        if name_lower.contains("_pp0")
            || name_lower.ends_with("pp0")
            || name_lower.contains("ia_cores")
            || name_lower.contains("_core")
        {
            return 2;
        }
        // Best: RAPL Package total (e.g. "RAPL_Package0_PKG", AMD "PPT")
        if name_lower.contains("_pkg")
            || name_lower.ends_with("pkg")
            || name_lower.contains("ppt")
            || name_lower.contains("package")
        {
            return 4;
        }
        // Generic CPU fallback
        if name_lower.contains("rapl")
            || name_lower.contains("cpu")
            || name_lower.contains("processor")
        {
            return 1;
        }
        0
    }

    // -------------------------------------------------------------------------
    // 3. HWiNFO64 Shared Memory (`Global\HWiNFO_SENS_SM2`) — Zero-latency reader
    // -------------------------------------------------------------------------
    const HWINFO_MAGIC: u32 = 0x53695748; // 'SiWH'
    const HWINFO_TYPE_TEMP: u32 = 1;
    const HWINFO_TYPE_POWER: u32 = 5;

    #[repr(C, packed)]
    #[derive(Copy, Clone)]
    struct HWiNFOHeader {
        magic: u32,
        version: u32,
        version2: u32,
        last_update: i64,
        sensor_section_offset: u32,
        sensor_element_size: u32,
        sensor_element_count: u32,
        entry_section_offset: u32,
        entry_element_size: u32,
        entry_element_count: u32,
    }

    #[repr(C, packed)]
    #[derive(Copy, Clone)]
    struct HWiNFOSensor {
        id: u32,
        instance: u32,
        name_original: [u8; 128],
        name_user: [u8; 128],
    }

    #[repr(C, packed)]
    #[derive(Copy, Clone)]
    struct HWiNFOReading {
        reading_type: u32,
        sensor_index: u32,
        reading_id: u32,
        label_original: [u8; 128],
        label_user: [u8; 128],
        units: [u8; 16],
        value: f64,
        value_min: f64,
        value_max: f64,
        value_avg: f64,
    }

    fn read_hwinfo_cpu_sensors() -> Option<(Option<f32>, Option<f32>)> {
        unsafe {
            let map_handle =
                OpenFileMappingW(FILE_MAP_READ.0, false, w!("Global\\HWiNFO_SENS_SM2")).ok()?;
            if map_handle.is_invalid() {
                return None;
            }

            let mutex = OpenMutexW(
                SYNCHRONIZATION_ACCESS_RIGHTS(0x00100000), // SYNCHRONIZE
                false,
                w!("Global\\HWiNFO_SM2_MUTEX"),
            )
            .ok();

            let locked = if let Some(m) = mutex {
                WaitForSingleObject(m, 25) == WAIT_OBJECT_0
            } else {
                false
            };

            let view = MapViewOfFile(map_handle, FILE_MAP_READ, 0, 0, 0);
            if view.Value.is_null() {
                if let Some(m) = mutex {
                    if locked {
                        let _ = ReleaseMutex(m);
                    }
                    let _ = CloseHandle(m);
                }
                let _ = CloseHandle(map_handle);
                return None;
            }

            let base = view.Value as *const u8;
            let header = std::ptr::read_unaligned(base as *const HWiNFOHeader);

            let result = if header.magic == HWINFO_MAGIC
                && header.sensor_element_size as usize >= std::mem::size_of::<HWiNFOSensor>()
                && header.entry_element_size as usize >= std::mem::size_of::<HWiNFOReading>()
                && header.sensor_element_count <= 256
                && header.entry_element_count <= 4096
            {
                let mut cpu_sensor_indices = vec![false; header.sensor_element_count as usize];
                for i in 0..header.sensor_element_count as usize {
                    let s_ptr = base.add(
                        header.sensor_section_offset as usize
                            + i * header.sensor_element_size as usize,
                    ) as *const HWiNFOSensor;
                    let sensor = std::ptr::read_unaligned(s_ptr);
                    let name = cstr_bytes(&sensor.name_original).to_lowercase();
                    if is_cpu_sensor_group(&name) {
                        cpu_sensor_indices[i] = true;
                    }
                }

                let mut best_temp: Option<(u8, f32)> = None;
                let mut best_power: Option<(u8, f32)> = None;

                for i in 0..header.entry_element_count as usize {
                    let r_ptr = base.add(
                        header.entry_section_offset as usize
                            + i * header.entry_element_size as usize,
                    ) as *const HWiNFOReading;
                    let r = std::ptr::read_unaligned(r_ptr);
                    let s_idx = r.sensor_index as usize;
                    if s_idx >= cpu_sensor_indices.len() || !cpu_sensor_indices[s_idx] {
                        continue;
                    }
                    let val = r.value;
                    if !val.is_finite() {
                        continue;
                    }
                    let label = cstr_bytes(&r.label_original).to_lowercase();

                    if r.reading_type == HWINFO_TYPE_TEMP && (5.0..=125.0).contains(&val) {
                        let prio = score_cpu_temp_label(&label);
                        if prio > 0 && best_temp.map_or(true, |(p, _)| prio > p) {
                            best_temp = Some((prio, ((val as f32) * 10.0).round() / 10.0));
                        }
                    } else if r.reading_type == HWINFO_TYPE_POWER && (0.1..=600.0).contains(&val) {
                        let prio = score_cpu_power_label(&label);
                        if prio > 0 && best_power.map_or(true, |(p, _)| prio > p) {
                            best_power = Some((prio, ((val as f32) * 10.0).round() / 10.0));
                        }
                    }
                }

                let t = best_temp.map(|(_, v)| v);
                let p = best_power.map(|(_, v)| v);
                if t.is_some() || p.is_some() {
                    Some((t, p))
                } else {
                    None
                }
            } else {
                None
            };

            let _ = UnmapViewOfFile(view);
            if let Some(m) = mutex {
                if locked {
                    let _ = ReleaseMutex(m);
                }
                let _ = CloseHandle(m);
            }
            let _ = CloseHandle(map_handle);
            result
        }
    }

    fn cstr_bytes(buf: &[u8]) -> String {
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        String::from_utf8_lossy(&buf[..end]).trim().to_string()
    }

    fn is_cpu_sensor_group(name: &str) -> bool {
        if name.contains("gpu")
            || name.contains("nvidia")
            || name.contains("geforce")
            || name.contains("radeon")
            || name.contains("drive")
            || name.contains("nvme")
            || name.contains("dimm")
            || name.contains("network")
        {
            return false;
        }
        name.contains("cpu")
            || name.contains("intel core")
            || name.contains("amd ryzen")
            || name.contains("dts")
            || name.contains("enhanced")
    }

    fn score_cpu_temp_label(label: &str) -> u8 {
        if label.contains("distance") || label.contains("limit") || label.contains("tjmax") || label.contains("throttle") {
            return 0;
        }
        if label == "cpu package" || label.contains("cpu package") {
            return 10;
        }
        if label.contains("tctl/tdie") || label.contains("tdie") || label.contains("tctl") {
            return 9;
        }
        if label.contains("core max") || label.contains("package") {
            return 8;
        }
        if label.contains("core average") || label.contains("core temperatures") {
            return 7;
        }
        if label.contains("cpu") || label.contains("core") {
            return 4;
        }
        0
    }

    fn score_cpu_power_label(label: &str) -> u8 {
        if label.contains("limit") || label.contains("pl1") || label.contains("pl2") || label.contains("dram") || label.contains("gt") || label.contains("gpu") {
            return 0;
        }
        if label.contains("cpu package power") || label == "cpu package" {
            return 10;
        }
        if label.contains("package power") || label.contains("cpu ppt") || label == "package" {
            return 9;
        }
        if label.contains("ia cores") || label.contains("cpu cores") {
            return 6;
        }
        if label.contains("cpu") && label.contains("power") {
            return 5;
        }
        0
    }

    // -------------------------------------------------------------------------
    // 4. LibreHardwareMonitor / OpenHardwareMonitor WMI Reader (optional)
    // -------------------------------------------------------------------------
    struct WmiHwMonitor {
        services: IWbemServices,
        source_name: &'static str,
    }

    // SAFETY: Created and used exclusively on the single telemetry worker thread (COM MTA).
    unsafe impl Send for WmiHwMonitor {}

    impl WmiHwMonitor {
        fn try_connect() -> Option<Self> {
            unsafe {
                let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
                if hr.is_err() && hr != RPC_E_CHANGED_MODE {
                    return None;
                }

                let locator: IWbemLocator =
                    CoCreateInstance(&WbemLocator, None, CLSCTX_INPROC_SERVER).ok()?;

                for (ns, label) in [
                    ("root\\LibreHardwareMonitor", "LibreHardwareMonitor"),
                    ("root\\OpenHardwareMonitor", "OpenHardwareMonitor"),
                ] {
                    let ns_bstr = BSTR::from(ns);
                    if let Ok(svc) = locator.ConnectServer(
                        &ns_bstr,
                        &BSTR::new(),
                        &BSTR::new(),
                        &BSTR::new(),
                        0,
                        &BSTR::new(),
                        None,
                    ) {
                        let _ = CoSetProxyBlanket(
                            &svc,
                            10, // RPC_C_AUTHN_WINNT
                            0,  // RPC_C_AUTHZ_NONE
                            None,
                            RPC_C_AUTHN_LEVEL_CALL,
                            RPC_C_IMP_LEVEL_IMPERSONATE,
                            None,
                            EOAC_NONE,
                        );
                        return Some(Self {
                            services: svc,
                            source_name: label,
                        });
                    }
                }
                None
            }
        }

        fn query_cpu(&self) -> Option<(Option<f32>, Option<f32>)> {
            unsafe {
                let query = BSTR::from(
                    "SELECT Name, SensorType, Value, Identifier FROM Sensor WHERE SensorType='Temperature' OR SensorType='Power'",
                );
                let wql = BSTR::from("WQL");
                let enumerator = self
                    .services
                    .ExecQuery(
                        &wql,
                        &query,
                        WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY,
                        None,
                    )
                    .ok()?;

                let mut best_temp: Option<(u8, f32)> = None;
                let mut best_power: Option<(u8, f32)> = None;
                let mut saw_any_row = false;

                loop {
                    let mut objs = [None; 1];
                    let mut returned = 0u32;
                    let hr = enumerator.Next(WBEM_INFINITE, &mut objs, &mut returned);
                    if hr.is_err() || returned == 0 {
                        break;
                    }
                    let Some(obj) = objs[0].take() else {
                        break;
                    };
                    saw_any_row = true;

                    let ident = get_wmi_string(&obj, w!("Identifier")).unwrap_or_default().to_lowercase();
                    if !(ident.contains("cpu") || ident.contains("intelcpu") || ident.contains("amdcpu")) {
                        continue;
                    }
                    let sensor_type = get_wmi_string(&obj, w!("SensorType")).unwrap_or_default();
                    let name = get_wmi_string(&obj, w!("Name")).unwrap_or_default().to_lowercase();
                    let Some(val) = get_wmi_f32(&obj, w!("Value")) else {
                        continue;
                    };

                    if sensor_type.eq_ignore_ascii_case("Temperature") && (5.0..=125.0).contains(&val) {
                        let prio = score_cpu_temp_label(&name);
                        if prio > 0 && best_temp.map_or(true, |(p, _)| prio > p) {
                            best_temp = Some((prio, (val * 10.0).round() / 10.0));
                        }
                    } else if sensor_type.eq_ignore_ascii_case("Power") && (0.1..=600.0).contains(&val) {
                        let prio = score_cpu_power_label(&name);
                        if prio > 0 && best_power.map_or(true, |(p, _)| prio > p) {
                            best_power = Some((prio, (val * 10.0).round() / 10.0));
                        }
                    }
                }

                if !saw_any_row {
                    return None;
                }
                Some((best_temp.map(|(_, v)| v), best_power.map(|(_, v)| v)))
            }
        }
    }

    unsafe fn get_wmi_string(
        obj: &windows::Win32::System::Wmi::IWbemClassObject,
        field: PCWSTR,
    ) -> Option<String> {
        let mut var = VARIANT::default();
        if obj.Get(field, 0, &mut var, None, None).is_err() {
            return None;
        }
        let s = var.to_string();
        if s.is_empty() { None } else { Some(s) }
    }

    unsafe fn get_wmi_f32(
        obj: &windows::Win32::System::Wmi::IWbemClassObject,
        field: PCWSTR,
    ) -> Option<f32> {
        let mut var = VARIANT::default();
        if obj.Get(field, 0, &mut var, None, None).is_err() {
            return None;
        }
        let s = var.to_string();
        s.trim()
            .replace(',', ".")
            .parse::<f32>()
            .ok()
            .filter(|v| v.is_finite())
    }

    // -------------------------------------------------------------------------
    // Combined CpuSensorCollector
    // -------------------------------------------------------------------------
    pub struct CpuSensorCollector {
        pdh: Option<PdhCpuCounters>,
        emi: EmiCollector,
        wmi_hw: Option<WmiHwMonitor>,
        hwinfo_active: bool,
        tick: u64,
        cached_ext_temp: Option<f32>,
        cached_ext_power: Option<f32>,
        cached_ext_source: Option<String>,
    }

    impl CpuSensorCollector {
        pub fn new() -> Self {
            let pdh = PdhCpuCounters::open();
            let emi = EmiCollector::discover();
            let hwinfo_init = read_hwinfo_cpu_sensors();
            let hwinfo_active = hwinfo_init.is_some();
            let wmi_hw = if hwinfo_active {
                None
            } else {
                WmiHwMonitor::try_connect()
            };

            Self {
                pdh,
                emi,
                wmi_hw,
                hwinfo_active,
                tick: 0,
                cached_ext_temp: None,
                cached_ext_power: None,
                cached_ext_source: None,
            }
        }

        pub fn sample(&mut self, fallback_base_mhz: u64, logical_cores: usize) -> CpuSensorReading {
            self.tick += 1;

            // 1. Always read fast PDH counters (real Turbo clock + per-core clocks + ACPI thermal + Power Meter)
            let (effective_freq_mhz, base_freq_mhz, per_core_freq_mhz, pdh_temp, pdh_power) =
                if let Some(ref mut pdh) = self.pdh {
                    pdh.sample(fallback_base_mhz, logical_cores)
                } else {
                    (None, None, Vec::new(), None, None)
                };

            // 2. Read Windows native EMI (RAPL) CPU package power
            let emi_power = self.emi.sample_cpu_watts();

            // 3. Poll HWiNFO Shared Memory (fast) or LibreHardwareMonitor WMI (every 2 ticks)
            let poll_ext = self.tick == 1 || self.tick % 2 == 0;
            if poll_ext {
                let try_hwinfo = self.hwinfo_active || self.tick == 1 || self.tick % 15 == 0;
                let mut got_hwinfo = false;
                if try_hwinfo {
                    if let Some((t, p)) = read_hwinfo_cpu_sensors() {
                        self.hwinfo_active = true;
                        self.cached_ext_temp = t;
                        self.cached_ext_power = p;
                        self.cached_ext_source = Some("HWiNFO".to_string());
                        got_hwinfo = true;
                    } else {
                        self.hwinfo_active = false;
                    }
                }

                if !got_hwinfo {
                    if self.wmi_hw.is_none() && (self.tick % 30 == 0) {
                        self.wmi_hw = WmiHwMonitor::try_connect();
                    }
                    if let Some(ref wmi) = self.wmi_hw {
                        if let Some((t, p)) = wmi.query_cpu() {
                            self.cached_ext_temp = t;
                            self.cached_ext_power = p;
                            self.cached_ext_source = Some(wmi.source_name.to_string());
                        } else {
                            // Monitor exited; clear cache & disconnect
                            self.wmi_hw = None;
                            self.cached_ext_temp = None;
                            self.cached_ext_power = None;
                            self.cached_ext_source = None;
                        }
                    } else {
                        self.cached_ext_temp = None;
                        self.cached_ext_power = None;
                        self.cached_ext_source = None;
                    }
                }
            }

            // Combine with clear priority: HWiNFO / LHM > Windows EMI / PDH
            let mut temp_src: Option<&str> = None;
            let temperature_c = if let Some(t) = self.cached_ext_temp {
                temp_src = self.cached_ext_source.as_deref();
                Some(t)
            } else if let Some(t) = pdh_temp {
                temp_src = Some("ACPI");
                Some(t)
            } else {
                None
            };

            let mut power_src: Option<&str> = None;
            let power_watts = if let Some(p) = self.cached_ext_power {
                power_src = self.cached_ext_source.as_deref();
                Some(p)
            } else if let Some(p) = emi_power {
                power_src = Some("Windows EMI");
                Some(p)
            } else if let Some(p) = pdh_power {
                power_src = Some("Power Meter");
                Some(p)
            } else {
                None
            };

            let sensor_source = match (temp_src, power_src) {
                (Some(a), Some(b)) if a == b => Some(a.to_string()),
                (Some(a), Some(b)) => Some(format!("{a} / {b}")),
                (Some(a), None) => Some(a.to_string()),
                (None, Some(b)) => Some(b.to_string()),
                (None, None) => None,
            };

            CpuSensorReading {
                effective_freq_mhz,
                base_freq_mhz,
                per_core_freq_mhz,
                temperature_c,
                power_watts,
                sensor_source,
            }
        }
    }
}

#[cfg(windows)]
pub use win_impl::{is_acpi_dummy_celsius, CpuSensorCollector};

#[cfg(not(windows))]
pub fn is_acpi_dummy_celsius(_c: f32) -> bool {
    false
}

#[cfg(all(test, windows))]
mod tests {
    use super::win_impl::{is_acpi_dummy_celsius, is_cpu_power_channel};
    use super::CpuSensorCollector;

    #[test]
    fn collector_initializes_and_samples_without_panicking() {
        let mut c = CpuSensorCollector::new();
        let reading = c.sample(3400, 8);
        assert!(reading.effective_freq_mhz.map_or(true, |f| (300..=10000).contains(&f)));
        assert!(reading.temperature_c.map_or(true, |t| (5.0..=125.0).contains(&t)));
        assert!(reading.power_watts.map_or(true, |w| (0.1..=600.0).contains(&w)));
    }

    #[test]
    fn rapl_pkg_beats_pp0_so_power_is_never_double_counted() {
        let pkg = is_cpu_power_channel("rapl_package0_pkg");
        let pp0 = is_cpu_power_channel("rapl_package0_pp0");
        let pp1 = is_cpu_power_channel("rapl_package0_pp1");
        let dram = is_cpu_power_channel("rapl_package0_dram");
        let psys = is_cpu_power_channel("rapl_package0_psys");
        assert!(pkg > pp0);
        assert!(pp0 > 0);
        assert_eq!(pp1, 0);
        assert_eq!(dram, 0);
        assert_eq!(psys, 0);
    }

    #[test]
    fn filters_known_intel_acpi_dummy_stubs() {
        assert!(is_acpi_dummy_celsius(27.85));
        assert!(is_acpi_dummy_celsius(27.9));
        assert!(is_acpi_dummy_celsius(26.85));
        assert!(!is_acpi_dummy_celsius(45.2));
        assert!(!is_acpi_dummy_celsius(68.0));
    }
}
