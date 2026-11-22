//! Single-instance enforcement on Windows using a per-session Named Mutex and
//! Named Auto-Reset Event with a cross-integrity security descriptor (SDDL).
//!
//! Why custom Win32 instead of `WM_COPYDATA`?
//! - A non-elevated taskbar click (Medium Integrity) must be able to wake an
//!   already-running elevated (Administrator / High Integrity) Spektr instance
//!   parked in the system tray without being blocked by UIPI.
//! - Supports seamless UAC elevation handoff (`--elevated-handoff`) when
//!   restarting as administrator via `restart_as_admin`.

#[cfg(windows)]
mod imp {
    use std::mem::size_of;
    use std::sync::Mutex;
    use std::thread::JoinHandle;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, FALSE,
        HANDLE, HLOCAL, WAIT_ABANDONED, WAIT_OBJECT_0,
    };
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows::Win32::System::Threading::{
        CreateEventW, CreateMutexW, OpenEventW, ReleaseMutex, SetEvent, WaitForMultipleObjects,
        WaitForSingleObject, EVENT_MODIFY_STATE, INFINITE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};

    const MUTEX_NAME: PCWSTR = w!("Local\\SpektrTaskmanager_SingleInstance_Mutex");
    const WAKE_EVENT_NAME: PCWSTR = w!("Local\\SpektrTaskmanager_ShowWindow_Event");

    /// DACL: Allow Authenticated Users full access within this interactive session (`Local\`).
    /// SACL: Low Mandatory Integrity Label so non-elevated launches can signal an elevated instance.
    const CROSS_INTEGRITY_SDDL: PCWSTR = w!("D:(A;;GA;;;AU)S:(ML;;NW;;;LW)");

    struct PermissiveSecurity {
        sd: PSECURITY_DESCRIPTOR,
        sa: SECURITY_ATTRIBUTES,
    }

    impl PermissiveSecurity {
        fn new() -> Option<Self> {
            let mut sd = PSECURITY_DESCRIPTOR::default();
            let ok = unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    CROSS_INTEGRITY_SDDL,
                    SDDL_REVISION_1,
                    &mut sd,
                    None,
                )
            };
            if ok.is_err() || sd.0.is_null() {
                return None;
            }
            let sa = SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: sd.0,
                bInheritHandle: FALSE,
            };
            Some(Self { sd, sa })
        }

        fn as_ptr(&self) -> *const SECURITY_ATTRIBUTES {
            &self.sa as *const SECURITY_ATTRIBUTES
        }
    }

    impl Drop for PermissiveSecurity {
        fn drop(&mut self) {
            if !self.sd.0.is_null() {
                unsafe {
                    let _ = LocalFree(Some(HLOCAL(self.sd.0)));
                }
            }
        }
    }

    struct Inner {
        mutex_handle: isize,
        wake_event: isize,
        stop_event: isize,
        listener: Option<JoinHandle<()>>,
    }

    pub struct SingleInstanceGuard {
        inner: Mutex<Option<Inner>>,
    }

    pub enum AcquireResult {
        Primary(SingleInstanceGuard),
        AlreadyRunning,
    }

    /// Acquires the single-instance lock.
    ///
    /// - If `is_handoff` is `true` (used by `restart_as_admin`), waits up to 5 s
    ///   for the exiting non-elevated instance to release the mutex.
    /// - If another instance is already running, optionally signals it to focus
    ///   its main window (unless `silent_if_running` is `true`) and returns
    ///   `AcquireResult::AlreadyRunning`.
    pub fn acquire(is_handoff: bool, silent_if_running: bool) -> AcquireResult {
        acquire_named(MUTEX_NAME, WAKE_EVENT_NAME, is_handoff, silent_if_running)
    }

    fn acquire_named(
        mutex_name: PCWSTR,
        wake_event_name: PCWSTR,
        is_handoff: bool,
        silent_if_running: bool,
    ) -> AcquireResult {
        let sec = PermissiveSecurity::new();
        let sa_ptr = sec.as_ref().map(|s| s.as_ptr());

        unsafe {
            let mutex_res = CreateMutexW(sa_ptr, true, mutex_name);
            let (mutex_handle, already_exists) = match mutex_res {
                Ok(h) => {
                    let exists = GetLastError() == ERROR_ALREADY_EXISTS;
                    (h, exists)
                }
                Err(e) => {
                    if e.code() == ERROR_ACCESS_DENIED.to_hresult() {
                        if !silent_if_running {
                            signal_existing_instance(wake_event_name);
                        }
                        return AcquireResult::AlreadyRunning;
                    }
                    // Unexpected OS failure — allow startup rather than locking the user out.
                    return AcquireResult::Primary(SingleInstanceGuard {
                        inner: Mutex::new(None),
                    });
                }
            };

            if already_exists {
                if is_handoff {
                    // Wait for the previous (non-elevated) instance to release the mutex.
                    let wait = WaitForSingleObject(mutex_handle, 5000);
                    if wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED {
                        let _ = CloseHandle(mutex_handle);
                        if !silent_if_running {
                            signal_existing_instance(wake_event_name);
                        }
                        return AcquireResult::AlreadyRunning;
                    }
                } else {
                    let _ = CloseHandle(mutex_handle);
                    if !silent_if_running {
                        signal_existing_instance(wake_event_name);
                    }
                    return AcquireResult::AlreadyRunning;
                }
            }

            let wake_event = CreateEventW(sa_ptr, false, false, wake_event_name)
                .map(|h| h.0 as isize)
                .unwrap_or(0);
            let stop_event = CreateEventW(None, true, false, PCWSTR::null())
                .map(|h| h.0 as isize)
                .unwrap_or(0);

            AcquireResult::Primary(SingleInstanceGuard {
                inner: Mutex::new(Some(Inner {
                    mutex_handle: mutex_handle.0 as isize,
                    wake_event,
                    stop_event,
                    listener: None,
                })),
            })
        }
    }

    fn signal_existing_instance(wake_event_name: PCWSTR) {
        unsafe {
            // Transfer foreground activation rights so the existing instance can
            // bring its window cleanly to the front instead of flashing in the taskbar.
            let _ = AllowSetForegroundWindow(ASFW_ANY);
            if let Ok(ev) = OpenEventW(EVENT_MODIFY_STATE, false, wake_event_name) {
                let _ = SetEvent(ev);
                let _ = CloseHandle(ev);
            }
        }
    }

    impl SingleInstanceGuard {
        pub fn start_listener<F>(&self, on_activate: F)
        where
            F: Fn() + Send + 'static,
        {
            let Ok(mut guard) = self.inner.lock() else {
                return;
            };
            let Some(inner) = guard.as_mut() else {
                return;
            };
            if inner.listener.is_some() || inner.wake_event == 0 || inner.stop_event == 0 {
                return;
            }

            let wake_raw = inner.wake_event;
            let stop_raw = inner.stop_event;

            let handle = std::thread::Builder::new()
                .name("spektr-single-instance".into())
                .spawn(move || {
                    let handles = [
                        HANDLE(wake_raw as *mut core::ffi::c_void),
                        HANDLE(stop_raw as *mut core::ffi::c_void),
                    ];
                    loop {
                        let wait = unsafe { WaitForMultipleObjects(&handles, false, INFINITE) };
                        if wait == WAIT_OBJECT_0 {
                            on_activate();
                        } else {
                            // stop_event signaled or wait failed
                            break;
                        }
                    }
                })
                .ok();

            inner.listener = handle;
        }

        pub fn release(&self) {
            let taken = self.inner.lock().ok().and_then(|mut g| g.take());
            if let Some(mut inner) = taken {
                unsafe {
                    if inner.stop_event != 0 {
                        let _ = SetEvent(HANDLE(inner.stop_event as *mut core::ffi::c_void));
                    }
                }
                if let Some(join) = inner.listener.take() {
                    let _ = join.join();
                }
                unsafe {
                    if inner.wake_event != 0 {
                        let _ = CloseHandle(HANDLE(inner.wake_event as *mut core::ffi::c_void));
                    }
                    if inner.stop_event != 0 {
                        let _ = CloseHandle(HANDLE(inner.stop_event as *mut core::ffi::c_void));
                    }
                    if inner.mutex_handle != 0 {
                        let h = HANDLE(inner.mutex_handle as *mut core::ffi::c_void);
                        let _ = ReleaseMutex(h);
                        let _ = CloseHandle(h);
                    }
                }
            }
        }
    }

    impl Drop for SingleInstanceGuard {
        fn drop(&mut self) {
            self.release();
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use std::time::Duration;

        #[test]
        fn single_instance_signals_and_releases() {
            let mutex_name = w!("Local\\SpektrTaskmanager_UnitTest_Mutex");
            let event_name = w!("Local\\SpektrTaskmanager_UnitTest_Event");

            let primary = match acquire_named(mutex_name, event_name, false, false) {
                AcquireResult::Primary(g) => g,
                AcquireResult::AlreadyRunning => panic!("expected Primary on first acquire"),
            };

            let wakes = Arc::new(AtomicUsize::new(0));
            let wakes_clone = Arc::clone(&wakes);
            primary.start_listener(move || {
                wakes_clone.fetch_add(1, Ordering::SeqCst);
            });

            // Second launch should detect existing instance and wake the primary listener.
            assert!(matches!(
                acquire_named(mutex_name, event_name, false, false),
                AcquireResult::AlreadyRunning
            ));

            for _ in 0..40 {
                if wakes.load(Ordering::SeqCst) >= 1 {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            assert_eq!(wakes.load(Ordering::SeqCst), 1);

            // Silent second launch (--start-minimized) should NOT trigger another wake.
            assert!(matches!(
                acquire_named(mutex_name, event_name, false, true),
                AcquireResult::AlreadyRunning
            ));
            std::thread::sleep(Duration::from_millis(40));
            assert_eq!(wakes.load(Ordering::SeqCst), 1);

            // After release, a new instance can acquire the primary lock again.
            primary.release();
            let reacquired = acquire_named(mutex_name, event_name, false, false);
            assert!(matches!(reacquired, AcquireResult::Primary(_)));
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub struct SingleInstanceGuard;

    pub enum AcquireResult {
        Primary(SingleInstanceGuard),
        AlreadyRunning,
    }

    pub fn acquire(_is_handoff: bool, _silent_if_running: bool) -> AcquireResult {
        AcquireResult::Primary(SingleInstanceGuard)
    }

    impl SingleInstanceGuard {
        pub fn start_listener<F>(&self, _on_activate: F)
        where
            F: Fn() + Send + 'static,
        {
        }

        pub fn release(&self) {}
    }
}

pub use imp::{acquire, AcquireResult, SingleInstanceGuard};
