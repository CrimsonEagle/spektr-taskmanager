//! Native Windows Disk Telemetry Collector:
//! - Persistent PDH `\LogicalDisk(*)` counters for:
//!   * Active Time % (`100 - % Idle Time`, matching Windows Task Manager)
//!   * Average Response Time in ms (`Avg. Disk sec/Transfer * 1000`)
//!   * Real per-drive Read & Write throughput (`Disk Read Bytes/sec`, `Disk Write Bytes/sec`)
//! - One-time non-elevated `IOCTL_STORAGE_QUERY_PROPERTY` per drive for:
//!   * Hardware model name (e.g. "WD_BLACK SN850 Heatsink 1TB")
//!   * Bus / interface type ("NVMe", "SATA", "USB", etc.)

use std::collections::HashMap;

#[derive(Debug, Clone, Default)]
pub struct LogicalDiskSample {
    pub active_percent: f32,
    pub avg_response_ms: f32,
    pub read_bytes_per_sec: u64,
    pub write_bytes_per_sec: u64,
}

#[derive(Debug, Clone, Default)]
pub struct DriveHardwareMeta {
    pub model: Option<String>,
    pub bus_type: Option<String>,
    pub is_system_drive: bool,
}

#[derive(Debug, Clone, Default)]
pub struct DiskSensorSnapshot {
    pub total_active_percent: f32,
    pub total_avg_response_ms: f32,
    pub total_read_bytes_per_sec: Option<u64>,
    pub total_write_bytes_per_sec: Option<u64>,
    pub per_drive: HashMap<String, LogicalDiskSample>, // keyed by uppercase "C:", "D:", ...
}

#[cfg(not(windows))]
pub struct DiskSensorCollector;

#[cfg(not(windows))]
impl DiskSensorCollector {
    pub fn new() -> Self {
        Self
    }
    pub fn sample(&mut self) -> DiskSensorSnapshot {
        DiskSensorSnapshot::default()
    }
    pub fn get_drive_hardware(&mut self, _mount_point: &str) -> DriveHardwareMeta {
        DriveHardwareMeta::default()
    }
}

#[cfg(windows)]
mod win_impl {
    use super::{DiskSensorSnapshot, DriveHardwareMeta, LogicalDiskSample};
    use std::collections::HashMap;
    use std::ffi::c_void;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows::Win32::System::IO::DeviceIoControl;
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
        PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE,
    };

    const IOCTL_STORAGE_QUERY_PROPERTY: u32 = 0x002D1400;

    #[repr(C)]
    struct StoragePropertyQuery {
        property_id: u32,
        query_type: u32,
        additional_parameters: [u8; 4],
    }

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct StorageDeviceDescriptorHeader {
        version: u32,
        size: u32,
        device_type: u8,
        device_type_modifier: u8,
        removable_media: u8,
        command_queueing: u8,
        vendor_id_offset: u32,
        product_id_offset: u32,
        product_revision_offset: u32,
        serial_number_offset: u32,
        bus_type: u32,
        raw_properties_length: u32,
    }

    pub struct DiskSensorCollector {
        query: Option<isize>,
        idle_counter: Option<isize>,
        response_counter: Option<isize>,
        read_counter: Option<isize>,
        write_counter: Option<isize>,
        array_buf: Vec<u8>,
        hw_cache: HashMap<String, DriveHardwareMeta>,
        system_drive: String,
    }

    impl Drop for DiskSensorCollector {
        fn drop(&mut self) {
            if let Some(q) = self.query.take() {
                unsafe {
                    let _ = PdhCloseQuery(q);
                }
            }
        }
    }

    impl DiskSensorCollector {
        pub fn new() -> Self {
            let system_drive = std::env::var("SystemDrive")
                .unwrap_or_else(|_| "C:".to_string())
                .trim_end_matches('\\')
                .to_uppercase();

            let (query, idle_counter, response_counter, read_counter, write_counter) =
                open_disk_pdh();

            Self {
                query,
                idle_counter,
                response_counter,
                read_counter,
                write_counter,
                array_buf: Vec::new(),
                hw_cache: HashMap::new(),
                system_drive,
            }
        }

        pub fn get_drive_hardware(&mut self, mount_point: &str) -> DriveHardwareMeta {
            let key = normalize_drive_key(mount_point);
            if let Some(cached) = self.hw_cache.get(&key) {
                return cached.clone();
            }

            let is_system_drive = !key.is_empty() && key == self.system_drive;
            let (model, bus_type) = if key.len() == 2 && key.ends_with(':') {
                query_storage_device_property(&key)
            } else {
                (None, None)
            };

            let meta = DriveHardwareMeta {
                model,
                bus_type,
                is_system_drive,
            };
            self.hw_cache.insert(key, meta.clone());
            meta
        }

        pub fn sample(&mut self) -> DiskSensorSnapshot {
            let Some(q) = self.query else {
                return DiskSensorSnapshot::default();
            };

            unsafe {
                if PdhCollectQueryData(q) != 0 {
                    return DiskSensorSnapshot::default();
                }
            }

            let mut per_drive: HashMap<String, LogicalDiskSample> = HashMap::new();
            let mut total_idle_pct: Option<f32> = None;
            let mut total_resp_ms: Option<f32> = None;
            let mut total_read: Option<u64> = None;
            let mut total_write: Option<u64> = None;

            if let Some(c) = self.idle_counter {
                for (name, val) in self.read_array(c) {
                    let active = (100.0 - val as f32).clamp(0.0, 100.0);
                    let rounded = (active * 10.0).round() / 10.0;
                    if name == "_Total" {
                        total_idle_pct = Some(rounded);
                    } else {
                        let key = normalize_drive_key(&name);
                        if !key.is_empty() {
                            per_drive.entry(key).or_default().active_percent = rounded;
                        }
                    }
                }
            }

            if let Some(c) = self.response_counter {
                for (name, val) in self.read_array(c) {
                    let ms = ((val * 1000.0) as f32).clamp(0.0, 9999.0);
                    let rounded = (ms * 10.0).round() / 10.0;
                    if name == "_Total" {
                        total_resp_ms = Some(rounded);
                    } else {
                        let key = normalize_drive_key(&name);
                        if !key.is_empty() {
                            per_drive.entry(key).or_default().avg_response_ms = rounded;
                        }
                    }
                }
            }

            if let Some(c) = self.read_counter {
                for (name, val) in self.read_array(c) {
                    let bps = val.max(0.0).round() as u64;
                    if name == "_Total" {
                        total_read = Some(bps);
                    } else {
                        let key = normalize_drive_key(&name);
                        if !key.is_empty() {
                            per_drive.entry(key).or_default().read_bytes_per_sec = bps;
                        }
                    }
                }
            }

            if let Some(c) = self.write_counter {
                for (name, val) in self.read_array(c) {
                    let bps = val.max(0.0).round() as u64;
                    if name == "_Total" {
                        total_write = Some(bps);
                    } else {
                        let key = normalize_drive_key(&name);
                        if !key.is_empty() {
                            per_drive.entry(key).or_default().write_bytes_per_sec = bps;
                        }
                    }
                }
            }

            // Use peak drive active time (matching how Task Manager highlights the busiest drive),
            // falling back to _Total if no individual drive instance was returned.
            let max_drive_active = per_drive
                .values()
                .map(|d| d.active_percent)
                .fold(0.0f32, f32::max);
            let total_active_percent = if !per_drive.is_empty() {
                max_drive_active
            } else {
                total_idle_pct.unwrap_or(0.0)
            };

            let total_avg_response_ms = total_resp_ms.unwrap_or_else(|| {
                per_drive
                    .values()
                    .map(|d| d.avg_response_ms)
                    .fold(0.0f32, f32::max)
            });

            DiskSensorSnapshot {
                total_active_percent,
                total_avg_response_ms,
                total_read_bytes_per_sec: total_read,
                total_write_bytes_per_sec: total_write,
                per_drive,
            }
        }

        fn read_array(&mut self, counter: isize) -> Vec<(String, f64)> {
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
                    let v = item.FmtValue.Anonymous.doubleValue;
                    if !v.is_finite() {
                        continue;
                    }
                    let name = item.szName.to_string().unwrap_or_default();
                    out.push((name, v));
                }
                out
            }
        }
    }

    pub fn normalize_drive_key(mount_or_inst: &str) -> String {
        let trimmed = mount_or_inst.trim().trim_end_matches('\\').trim_end_matches('/');
        if trimmed.len() == 2 && trimmed.ends_with(':') {
            trimmed.to_uppercase()
        } else {
            trimmed.to_uppercase()
        }
    }

    fn open_disk_pdh() -> (
        Option<isize>,
        Option<isize>,
        Option<isize>,
        Option<isize>,
        Option<isize>,
    ) {
        unsafe {
            let mut query = 0isize;
            if PdhOpenQueryW(None, 0, &mut query) != 0 {
                return (None, None, None, None, None);
            }

            let add = |path: PCWSTR| -> Option<isize> {
                let mut c = 0isize;
                if PdhAddEnglishCounterW(query, path, 0, &mut c) == 0 {
                    Some(c)
                } else {
                    None
                }
            };

            let idle = add(w!("\\LogicalDisk(*)\\% Idle Time"));
            let resp = add(w!("\\LogicalDisk(*)\\Avg. Disk sec/Transfer"));
            let read = add(w!("\\LogicalDisk(*)\\Disk Read Bytes/sec"));
            let write = add(w!("\\LogicalDisk(*)\\Disk Write Bytes/sec"));

            if idle.is_none() && resp.is_none() && read.is_none() && write.is_none() {
                let _ = PdhCloseQuery(query);
                return (None, None, None, None, None);
            }

            let _ = PdhCollectQueryData(query);
            (Some(query), idle, resp, read, write)
        }
    }

    fn query_storage_device_property(drive_letter: &str) -> (Option<String>, Option<String>) {
        unsafe {
            let dev_path = format!("\\\\.\\{drive_letter}");
            let mut wide: Vec<u16> = dev_path.encode_utf16().collect();
            wide.push(0);

            // Access = 0 queries device metadata without requiring administrator privileges
            let handle = CreateFileW(
                PCWSTR(wide.as_ptr()),
                0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            );
            let Ok(handle) = handle else {
                return (None, None);
            };
            if handle.is_invalid() || handle == INVALID_HANDLE_VALUE {
                return (None, None);
            }

            let query = StoragePropertyQuery {
                property_id: 0, // StorageDeviceProperty
                query_type: 0,  // PropertyStandardQuery
                additional_parameters: [0; 4],
            };
            let mut out_buf = vec![0u8; 1024];
            let mut returned = 0u32;

            let ok = DeviceIoControl(
                handle,
                IOCTL_STORAGE_QUERY_PROPERTY,
                Some(&query as *const _ as *const c_void),
                std::mem::size_of::<StoragePropertyQuery>() as u32,
                Some(out_buf.as_mut_ptr() as *mut c_void),
                out_buf.len() as u32,
                Some(&mut returned),
                None,
            )
            .is_ok();

            let _ = CloseHandle(handle);

            if !ok || (returned as usize) < std::mem::size_of::<StorageDeviceDescriptorHeader>() {
                return (None, None);
            }

            let hdr = std::ptr::read_unaligned(
                out_buf.as_ptr() as *const StorageDeviceDescriptorHeader
            );
            let valid_len = (returned as usize).min(out_buf.len());

            let vendor = read_cstr_at(&out_buf[..valid_len], hdr.vendor_id_offset as usize);
            let product = read_cstr_at(&out_buf[..valid_len], hdr.product_id_offset as usize);

            let model = match (vendor, product) {
                (Some(v), Some(p)) => {
                    if p.to_lowercase().starts_with(&v.to_lowercase()) {
                        Some(p)
                    } else {
                        Some(format!("{v} {p}"))
                    }
                }
                (None, Some(p)) => Some(p),
                (Some(v), None) => Some(v),
                (None, None) => None,
            };

            let bus_type = match hdr.bus_type {
                1 => Some("SCSI"),
                3 => Some("ATA"),
                7 => Some("USB"),
                8 => Some("RAID"),
                10 => Some("SAS"),
                11 => Some("SATA"),
                12 => Some("SD"),
                14 | 15 => Some("Virtuell"),
                17 => Some("NVMe"),
                _ => None,
            }
            .map(|s| s.to_string());

            (model, bus_type)
        }
    }

    fn read_cstr_at(buf: &[u8], offset: usize) -> Option<String> {
        if offset == 0 || offset >= buf.len() {
            return None;
        }
        let slice = &buf[offset..];
        let end = slice.iter().position(|&b| b == 0).unwrap_or(slice.len());
        let s = String::from_utf8_lossy(&slice[..end])
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if s.is_empty() { None } else { Some(s) }
    }
}

#[cfg(windows)]
pub use win_impl::{normalize_drive_key, DiskSensorCollector};

#[cfg(not(windows))]
pub fn normalize_drive_key(mount_or_inst: &str) -> String {
    mount_or_inst.trim().to_uppercase()
}
