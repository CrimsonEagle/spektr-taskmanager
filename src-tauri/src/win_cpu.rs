use std::collections::HashMap;

#[derive(Debug, Clone, Default)]
pub struct WinProcInfo {
    pub cpu_percent: f32,
    pub handle_count: u32,
    pub thread_count: u32,
    pub disk_read_bytes_per_sec: u64,
    pub disk_write_bytes_per_sec: u64,
    pub total_disk_read_bytes: u64,
    pub total_disk_write_bytes: u64,
}

#[derive(Debug, Clone, Default)]
pub struct WinCpuSnapshot {
    pub total_cpu_percent: Option<f32>,
    pub per_pid: HashMap<u32, WinProcInfo>,
}

struct PrevProcState {
    create_time: i64,
    total_cpu_100ns: u64,
    read_bytes: u64,
    write_bytes: u64,
}

#[cfg(windows)]
type NtQuerySystemInformationFn = unsafe extern "system" fn(
    system_information_class: u32,
    system_information: *mut std::ffi::c_void,
    system_information_length: u32,
    return_length: *mut u32,
) -> i32;

pub struct WinCpuSampler {
    prev_sys_idle: u64,
    prev_sys_kernel: u64,
    prev_sys_user: u64,
    prev_wall_filetime: u64,
    prev_procs: HashMap<u32, PrevProcState>,
    initialized: bool,
    #[cfg(windows)]
    nt_query: Option<NtQuerySystemInformationFn>,
    #[cfg(windows)]
    nt_buffer: Vec<u8>,
}

impl WinCpuSampler {
    pub fn new() -> Self {
        #[cfg(windows)]
        let nt_query = resolve_nt_query_system_information();

        let mut s = Self {
            prev_sys_idle: 0,
            prev_sys_kernel: 0,
            prev_sys_user: 0,
            prev_wall_filetime: 0,
            prev_procs: HashMap::new(),
            initialized: false,
            #[cfg(windows)]
            nt_query,
            #[cfg(windows)]
            nt_buffer: vec![0u8; 512 * 1024],
        };
        let _ = s.sample();
        s
    }

    #[cfg(windows)]
    pub fn sample(&mut self) -> WinCpuSnapshot {
        use windows::Win32::Foundation::FILETIME;
        use windows::Win32::System::SystemInformation::GetSystemTimeAsFileTime;
        use windows::Win32::System::Threading::GetSystemTimes;

        let mut f_idle = FILETIME::default();
        let mut f_kernel = FILETIME::default();
        let mut f_user = FILETIME::default();

        let sys_ok = unsafe {
            GetSystemTimes(
                Some(&mut f_idle),
                Some(&mut f_kernel),
                Some(&mut f_user),
            )
            .is_ok()
        };

        let now_ft = unsafe {
            let ft = GetSystemTimeAsFileTime();
            filetime_to_u64(ft)
        };

        let raw_procs = self.query_all_process_info();

        if !sys_ok || raw_procs.is_empty() {
            return WinCpuSnapshot::default();
        }

        let sys_idle = filetime_to_u64(f_idle);
        let sys_kernel = filetime_to_u64(f_kernel);
        let sys_user = filetime_to_u64(f_user);

        if !self.initialized {
            self.prev_sys_idle = sys_idle;
            self.prev_sys_kernel = sys_kernel;
            self.prev_sys_user = sys_user;
            self.prev_wall_filetime = now_ft;
            self.prev_procs = raw_procs
                .iter()
                .map(|p| {
                    (
                        p.pid,
                        PrevProcState {
                            create_time: p.create_time,
                            total_cpu_100ns: p.total_time,
                            read_bytes: p.read_bytes,
                            write_bytes: p.write_bytes,
                        },
                    )
                })
                .collect();
            self.initialized = true;
            return WinCpuSnapshot::default();
        }

        let delta_idle = sys_idle.saturating_sub(self.prev_sys_idle);
        let delta_kernel = sys_kernel.saturating_sub(self.prev_sys_kernel);
        let delta_user = sys_user.saturating_sub(self.prev_sys_user);
        let delta_total_sys = delta_kernel.saturating_add(delta_user);

        let elapsed_100ns = now_ft.saturating_sub(self.prev_wall_filetime);
        let elapsed_secs = (elapsed_100ns as f64 / 10_000_000.0).max(0.1);

        let prev_wall = self.prev_wall_filetime;

        let mut per_pid = HashMap::with_capacity(raw_procs.len());
        let mut next_prev = HashMap::with_capacity(raw_procs.len());

        let total_cpu_percent = if delta_total_sys > 0 {
            let busy = delta_total_sys.saturating_sub(delta_idle);
            Some(((busy as f64 / delta_total_sys as f64) * 100.0).clamp(0.0, 100.0) as f32)
        } else {
            None
        };

        for p in raw_procs {
            let (cpu_pct, read_rate, write_rate) = if p.pid == 0 || delta_total_sys == 0 {
                (0.0, 0, 0)
            } else if let Some(old) = self.prev_procs.get(&p.pid) {
                if old.create_time == p.create_time {
                    let delta_proc = p.total_time.saturating_sub(old.total_cpu_100ns);
                    let cpu = ((delta_proc as f64 / delta_total_sys as f64) * 100.0)
                        .clamp(0.0, 100.0) as f32;
                    let d_read = p.read_bytes.saturating_sub(old.read_bytes);
                    let d_write = p.write_bytes.saturating_sub(old.write_bytes);
                    (
                        cpu,
                        (d_read as f64 / elapsed_secs) as u64,
                        (d_write as f64 / elapsed_secs) as u64,
                    )
                } else {
                    let cpu = ((p.total_time as f64 / delta_total_sys as f64) * 100.0)
                        .clamp(0.0, 100.0) as f32;
                    (
                        cpu,
                        (p.read_bytes as f64 / elapsed_secs) as u64,
                        (p.write_bytes as f64 / elapsed_secs) as u64,
                    )
                }
            } else if p.create_time > 0
                && (p.create_time as u64) >= prev_wall.saturating_sub(5_000_000)
            {
                let cpu = ((p.total_time as f64 / delta_total_sys as f64) * 100.0)
                    .clamp(0.0, 100.0) as f32;
                (
                    cpu,
                    (p.read_bytes as f64 / elapsed_secs) as u64,
                    (p.write_bytes as f64 / elapsed_secs) as u64,
                )
            } else {
                (0.0, 0, 0)
            };

            next_prev.insert(
                p.pid,
                PrevProcState {
                    create_time: p.create_time,
                    total_cpu_100ns: p.total_time,
                    read_bytes: p.read_bytes,
                    write_bytes: p.write_bytes,
                },
            );

            per_pid.insert(
                p.pid,
                WinProcInfo {
                    cpu_percent: (cpu_pct * 10.0).round() / 10.0,
                    handle_count: p.handle_count,
                    thread_count: p.thread_count,
                    disk_read_bytes_per_sec: read_rate,
                    disk_write_bytes_per_sec: write_rate,
                    total_disk_read_bytes: p.read_bytes,
                    total_disk_write_bytes: p.write_bytes,
                },
            );
        }

        self.prev_sys_idle = sys_idle;
        self.prev_sys_kernel = sys_kernel;
        self.prev_sys_user = sys_user;
        self.prev_wall_filetime = now_ft;
        self.prev_procs = next_prev;

        WinCpuSnapshot {
            total_cpu_percent,
            per_pid,
        }
    }

    #[cfg(not(windows))]
    pub fn sample(&mut self) -> WinCpuSnapshot {
        WinCpuSnapshot::default()
    }
}

#[cfg(windows)]
#[inline]
fn filetime_to_u64(ft: windows::Win32::Foundation::FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64)
}

#[cfg(windows)]
struct RawProcInfo {
    pid: u32,
    create_time: i64,
    total_time: u64,
    handle_count: u32,
    thread_count: u32,
    read_bytes: u64,
    write_bytes: u64,
}

#[cfg(windows)]
#[repr(C)]
struct NtSystemProcessInformation {
    next_entry_offset: u32,
    number_of_threads: u32,
    working_set_private_size: i64,
    hard_fault_count: u32,
    number_of_threads_high_watermark: u32,
    cycle_time: u64,
    create_time: i64,
    user_time: i64,
    kernel_time: i64,
    image_name_len: u16,
    image_name_max_len: u16,
    image_name_buf: *mut u16,
    base_priority: i32,
    unique_process_id: usize,
    inherited_from_unique_process_id: usize,
    handle_count: u32,
    session_id: u32,
    unique_process_key: usize,
    peak_virtual_size: usize,
    virtual_size: usize,
    page_fault_count: u32,
    peak_working_set_size: usize,
    working_set_size: usize,
    quota_peak_paged_pool_usage: usize,
    quota_paged_pool_usage: usize,
    quota_peak_non_paged_pool_usage: usize,
    quota_non_paged_pool_usage: usize,
    pagefile_usage: usize,
    peak_pagefile_usage: usize,
    private_page_count: usize,
    read_operation_count: i64,
    write_operation_count: i64,
    other_operation_count: i64,
    read_transfer_count: i64,
    write_transfer_count: i64,
    other_transfer_count: i64,
}

#[cfg(windows)]
fn resolve_nt_query_system_information() -> Option<NtQuerySystemInformationFn> {
    use windows::core::{s, w};
    use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};

    unsafe {
        let ntdll = GetModuleHandleW(w!("ntdll.dll")).ok()?;
        let proc_ptr = GetProcAddress(ntdll, s!("NtQuerySystemInformation"))?;
        Some(std::mem::transmute(proc_ptr))
    }
}

#[cfg(windows)]
impl WinCpuSampler {
    fn query_all_process_info(&mut self) -> Vec<RawProcInfo> {
        use std::ffi::c_void;

        const SYSTEM_PROCESS_INFORMATION_CLASS: u32 = 5;
        const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC0000004u32 as i32;

        let Some(nt_query) = self.nt_query else {
            return Vec::new();
        };

        unsafe {
            loop {
                let mut ret_len: u32 = 0;
                let status = nt_query(
                    SYSTEM_PROCESS_INFORMATION_CLASS,
                    self.nt_buffer.as_mut_ptr() as *mut c_void,
                    self.nt_buffer.len() as u32,
                    &mut ret_len,
                );

                if status == STATUS_INFO_LENGTH_MISMATCH {
                    let next_size = (ret_len as usize).max(self.nt_buffer.len() * 2) + 65536;
                    if next_size > 64 * 1024 * 1024 {
                        return Vec::new();
                    }
                    self.nt_buffer.resize(next_size, 0);
                    continue;
                }

                if status < 0 {
                    return Vec::new();
                }
                break;
            }

            let mut results = Vec::with_capacity(512);
            let mut offset: usize = 0;
            let min_size = std::mem::size_of::<NtSystemProcessInformation>();

            while offset + min_size <= self.nt_buffer.len() {
                let entry =
                    &*(self.nt_buffer.as_ptr().add(offset) as *const NtSystemProcessInformation);
                let pid = entry.unique_process_id as u32;
                let user_t = entry.user_time.max(0) as u64;
                let kernel_t = entry.kernel_time.max(0) as u64;

                results.push(RawProcInfo {
                    pid,
                    create_time: entry.create_time,
                    total_time: user_t.saturating_add(kernel_t),
                    handle_count: entry.handle_count,
                    thread_count: entry.number_of_threads,
                    read_bytes: entry.read_transfer_count.max(0) as u64,
                    write_bytes: entry.write_transfer_count.max(0) as u64,
                });

                if entry.next_entry_offset == 0 {
                    break;
                }
                offset = offset.saturating_add(entry.next_entry_offset as usize);
            }

            results
        }
    }
}
