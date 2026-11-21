//! Real-time Per-Process Network Throughput Collector via Windows ETW
//! (`Microsoft-Windows-Kernel-Network`, GUID `{7DD42A49-5329-4832-8DFD-43D979153A88}`).
//!
//! Captures TCPv4/TCPv6 and UDPv4/UDPv6 Send (TX) and Receive (RX) byte counts
//! per Process ID in a lightweight dedicated real-time ETW trace session.
//!
//! Note: Windows restricts kernel network ETW sessions to Administrators or
//! members of the `Performance Log Users` group. When running unprivileged,
//! `NetThroughputCollector` degrades gracefully (`is_available() == false`)
//! without spawning background threads.

#[cfg(not(windows))]
use std::collections::HashMap;

#[cfg(not(windows))]
pub struct NetThroughputCollector {
    empty: HashMap<u32, (u64, u64)>,
}

#[cfg(not(windows))]
impl NetThroughputCollector {
    pub fn new() -> Self {
        Self {
            empty: HashMap::new(),
        }
    }

    pub fn is_available(&self) -> bool {
        false
    }

    pub fn sample(&mut self) -> &HashMap<u32, (u64, u64)> {
        &self.empty
    }
}

#[cfg(not(windows))]
pub fn stop_session_by_name() {}

#[cfg(windows)]
mod win_impl {
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;
    use windows::core::{GUID, PCWSTR, PWSTR};
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Diagnostics::Etw::{
        CloseTrace, ControlTraceW, EnableTraceEx2, OpenTraceW, ProcessTrace, StartTraceW,
        CONTROLTRACE_HANDLE, EVENT_CONTROL_CODE_ENABLE_PROVIDER, EVENT_RECORD,
        EVENT_TRACE_CONTROL_STOP, EVENT_TRACE_LOGFILEW, EVENT_TRACE_PROPERTIES,
        EVENT_TRACE_REAL_TIME_MODE, PROCESSTRACE_HANDLE, PROCESS_TRACE_MODE_EVENT_RECORD,
        PROCESS_TRACE_MODE_REAL_TIME, WNODE_FLAG_TRACED_GUID,
    };

    const INVALID_PROCESSTRACE_HANDLE_VALUE: u64 = u64::MAX;

    /// Unique ETW session name so we never conflict with "NT Kernel Logger" or Task Manager.
    const SESSION_NAME: &str = "PulseTaskManagerNetTrace";

    /// Microsoft-Windows-Kernel-Network provider GUID:
    /// `{7DD42A49-5329-4832-8DFD-43D979153A88}`
    const KERNEL_NETWORK_PROVIDER_GUID: GUID =
        GUID::from_u128(0x7dd42a49_5329_4832_8dfd_43d979153a88);

    /// IPv4 (0x10) | IPv6 (0x20) keywords for Microsoft-Windows-Kernel-Network.
    const KERNEL_NETWORK_KEYWORDS: u64 = 0x10 | 0x20;

    /// TRACE_LEVEL_VERBOSE (captures Informational level 4 send/recv events).
    const TRACE_LEVEL_VERBOSE: u8 = 5;

    struct SharedCounters {
        /// Map of PID -> (accumulated_rx_bytes, accumulated_tx_bytes) since last drain.
        bytes: Mutex<HashMap<u32, (u64, u64)>>,
        stopped: AtomicBool,
    }

    fn wide_session_name() -> Vec<u16> {
        SESSION_NAME
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect()
    }

    /// Allocate an 8-byte aligned, zeroed buffer holding `EVENT_TRACE_PROPERTIES`
    /// followed by space for the logger name.
    fn alloc_trace_properties(name_wide_len: usize) -> (Vec<u64>, u32) {
        let props_size = std::mem::size_of::<EVENT_TRACE_PROPERTIES>();
        let name_bytes = name_wide_len * std::mem::size_of::<u16>();
        let total_bytes = props_size + name_bytes + 64;
        let u64_len = total_bytes.div_ceil(8);
        let buf = vec![0u64; u64_len];
        (buf, (u64_len * 8) as u32)
    }

    /// Stop any existing `PulseTaskManagerNetTrace` session (e.g. leftover from a previous run
    /// or during graceful app exit).
    pub fn stop_session_by_name() {
        let name_wide = wide_session_name();
        let (mut buf, buf_size) = alloc_trace_properties(name_wide.len());
        unsafe {
            let props = buf.as_mut_ptr() as *mut EVENT_TRACE_PROPERTIES;
            (*props).Wnode.BufferSize = buf_size;
            (*props).LoggerNameOffset = std::mem::size_of::<EVENT_TRACE_PROPERTIES>() as u32;
            let _ = ControlTraceW(
                CONTROLTRACE_HANDLE { Value: 0 },
                PCWSTR(name_wide.as_ptr()),
                props,
                EVENT_TRACE_CONTROL_STOP,
            );
        }
    }

    unsafe extern "system" fn etw_event_callback(record_ptr: *mut EVENT_RECORD) {
        if record_ptr.is_null() {
            return;
        }
        let record = &*record_ptr;

        // Verify provider GUID to ignore ETW session header/meta events.
        if record.EventHeader.ProviderId != KERNEL_NETWORK_PROVIDER_GUID {
            return;
        }

        // Microsoft-Windows-Kernel-Network Send/Recv Event IDs:
        //   TCPv4: 10 = Send (TX), 11 = Recv (RX)
        //   TCPv6: 26 = Send (TX), 27 = Recv (RX)
        //   UDPv4: 42 = Send (TX), 43 = Recv (RX)
        //   UDPv6: 58 = Send (TX), 59 = Recv (RX)
        let is_tx = match record.EventHeader.EventDescriptor.Id {
            10 | 26 | 42 | 58 => true,
            11 | 27 | 43 | 59 => false,
            _ => return,
        };

        if record.UserData.is_null() || record.UserDataLength < 8 {
            return;
        }

        // All 8 events begin with: uint32 PID (offset 0), uint32 size (offset 4).
        let data = std::slice::from_raw_parts(record.UserData as *const u8, 8);
        let mut pid = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
        let size = u32::from_le_bytes([data[4], data[5], data[6], data[7]]) as u64;

        if size == 0 {
            return;
        }

        if pid == u32::MAX {
            let hdr_pid = record.EventHeader.ProcessId;
            if hdr_pid == u32::MAX {
                return;
            }
            pid = hdr_pid;
        }

        let ctx = record.UserContext;
        if ctx.is_null() {
            return;
        }
        let shared = &*(ctx as *const SharedCounters);
        if shared.stopped.load(Ordering::Relaxed) {
            return;
        }

        if let Ok(mut map) = shared.bytes.lock() {
            let entry = map.entry(pid).or_insert((0, 0));
            if is_tx {
                entry.1 = entry.1.saturating_add(size);
            } else {
                entry.0 = entry.0.saturating_add(size);
            }
        }
    }

    pub struct NetThroughputCollector {
        available: bool,
        shared: Arc<SharedCounters>,
        last_sample_at: Instant,
        last_rates: HashMap<u32, (u64, u64)>,
    }

    impl Drop for NetThroughputCollector {
        fn drop(&mut self) {
            self.shared.stopped.store(true, Ordering::Relaxed);
            if self.available {
                // Stopping the ETW session causes ProcessTrace on the background thread
                // to exit cleanly and call CloseTrace once.
                stop_session_by_name();
            }
        }
    }

    impl NetThroughputCollector {
        pub fn new() -> Self {
            let shared = Arc::new(SharedCounters {
                bytes: Mutex::new(HashMap::new()),
                stopped: AtomicBool::new(false),
            });

            // Clean up any stale session left over from a previous crashed run.
            stop_session_by_name();

            let name_wide = wide_session_name();
            let (mut prop_buf, buf_size) = alloc_trace_properties(name_wide.len());

            let mut session_handle = CONTROLTRACE_HANDLE { Value: 0 };
            let start_err = unsafe {
                let props = prop_buf.as_mut_ptr() as *mut EVENT_TRACE_PROPERTIES;
                (*props).Wnode.BufferSize = buf_size;
                (*props).Wnode.Flags = WNODE_FLAG_TRACED_GUID;
                (*props).Wnode.ClientContext = 1; // QueryPerformanceCounter
                (*props).LogFileMode = EVENT_TRACE_REAL_TIME_MODE;
                (*props).BufferSize = 64; // 64 KB buffers
                (*props).MinimumBuffers = 4;
                (*props).MaximumBuffers = 16;
                (*props).FlushTimer = 1; // Flush every 1s for responsive live rates
                (*props).LoggerNameOffset = std::mem::size_of::<EVENT_TRACE_PROPERTIES>() as u32;

                StartTraceW(&mut session_handle, PCWSTR(name_wide.as_ptr()), props)
            };

            if start_err != ERROR_SUCCESS {
                return Self {
                    available: false,
                    shared,
                    last_sample_at: Instant::now(),
                    last_rates: HashMap::new(),
                };
            }

            let enable_err = unsafe {
                EnableTraceEx2(
                    session_handle,
                    &KERNEL_NETWORK_PROVIDER_GUID,
                    EVENT_CONTROL_CODE_ENABLE_PROVIDER.0,
                    TRACE_LEVEL_VERBOSE,
                    KERNEL_NETWORK_KEYWORDS,
                    0,
                    0,
                    None,
                )
            };

            if enable_err != ERROR_SUCCESS {
                stop_session_by_name();
                return Self {
                    available: false,
                    shared,
                    last_sample_at: Instant::now(),
                    last_rates: HashMap::new(),
                };
            }

            // Open the real-time trace consumer synchronously so we know immediately if it works.
            let mut open_name_wide = wide_session_name();
            let shared_for_thread = Arc::clone(&shared);
            let trace_handle = unsafe {
                let mut log_file: EVENT_TRACE_LOGFILEW = std::mem::zeroed();
                log_file.LoggerName = PWSTR(open_name_wide.as_mut_ptr());
                log_file.Anonymous1.ProcessTraceMode =
                    PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD;
                log_file.Anonymous2.EventRecordCallback = Some(etw_event_callback);
                log_file.Context = Arc::as_ptr(&shared_for_thread) as *mut c_void;
                OpenTraceW(&mut log_file)
            };

            if trace_handle.Value == INVALID_PROCESSTRACE_HANDLE_VALUE {
                stop_session_by_name();
                return Self {
                    available: false,
                    shared,
                    last_sample_at: Instant::now(),
                    last_rates: HashMap::new(),
                };
            }

            let raw_trace_handle = trace_handle.Value;
            let spawn_res = std::thread::Builder::new()
                .name("pulse-net-etw".into())
                .spawn(move || {
                    // Keep `shared_for_thread` alive for the entire duration of `ProcessTrace`
                    // so `EVENT_RECORD.UserContext` remains valid until `ProcessTrace` exits.
                    let _keep_alive = shared_for_thread;
                    let handles = [PROCESSTRACE_HANDLE {
                        Value: raw_trace_handle,
                    }];
                    unsafe {
                        let _ = ProcessTrace(&handles, None, None);
                        let _ = CloseTrace(PROCESSTRACE_HANDLE {
                            Value: raw_trace_handle,
                        });
                    }
                });

            if spawn_res.is_err() {
                unsafe {
                    let _ = CloseTrace(trace_handle);
                }
                stop_session_by_name();
                return Self {
                    available: false,
                    shared,
                    last_sample_at: Instant::now(),
                    last_rates: HashMap::new(),
                };
            }

            Self {
                available: true,
                shared,
                last_sample_at: Instant::now(),
                last_rates: HashMap::new(),
            }
        }

        pub fn is_available(&self) -> bool {
            self.available
        }

        /// Drains accumulated per-PID byte counters and returns `(rx_bytes_per_sec, tx_bytes_per_sec)`.
        /// Holds the previous rate when called faster than ~0.85s so 500ms UI ticks align cleanly
        /// with ETW's 1-second flush timer without alternating zero-flicker.
        pub fn sample(&mut self) -> &HashMap<u32, (u64, u64)> {
            if !self.available {
                return &self.last_rates;
            }

            let now = Instant::now();
            let elapsed = now.duration_since(self.last_sample_at).as_secs_f64();
            if elapsed < 0.85 {
                return &self.last_rates;
            }

            let drained = match self.shared.bytes.lock() {
                Ok(mut guard) => std::mem::take(&mut *guard),
                Err(poisoned) => std::mem::take(&mut *poisoned.into_inner()),
            };

            let mut next_rates = HashMap::with_capacity(drained.len());
            for (pid, (rx, tx)) in drained {
                let rx_rate = (rx as f64 / elapsed).round() as u64;
                let tx_rate = (tx as f64 / elapsed).round() as u64;
                if rx_rate > 0 || tx_rate > 0 {
                    next_rates.insert(pid, (rx_rate, tx_rate));
                }
            }

            self.last_sample_at = now;
            self.last_rates = next_rates;
            &self.last_rates
        }
    }
}

#[cfg(windows)]
pub use win_impl::{stop_session_by_name, NetThroughputCollector};
