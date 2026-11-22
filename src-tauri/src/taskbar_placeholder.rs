//! Zero-WebView native Win32 minimized taskbar placeholder window.
//!
//! When the user minimizes Spektr normally (without minimizing to the system tray)
//! and "Release WebView when minimized to Taskbar" is enabled, we show this tiny
//! native Win32 window as `SW_SHOWMINNOACTIVE` in the Windows Taskbar and close the
//! Tauri `WebviewWindow`. All `msedgewebview2.exe` child processes terminate cleanly
//! (freeing ~100-250 MB RAM and 0% WebView CPU), while Spektr remains right in the
//! Windows Taskbar.
//!
//! When the user clicks the Taskbar button (or Alt+Tabs / restores via Win+D),
//! `WM_QUERYOPEN` / `WM_SYSCOMMAND(SC_RESTORE|SC_MAXIMIZE)` is intercepted before
//! the placeholder ever draws on screen, triggering `on_restore` to recreate the
//! real Tauri `WebviewWindow` seamlessly.

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
    use std::sync::{Arc, Condvar, Mutex, Once};
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CopyIcon, CreateWindowExW, DefWindowProcW, DestroyIcon, DestroyWindow, DispatchMessageW,
        GetClassLongPtrW, GetMessageW, GetWindowLongPtrW, LoadImageW, PostMessageW,
        PostQuitMessage, RegisterClassExW, SendMessageW, SetWindowLongPtrW, ShowWindow,
        TranslateMessage, GCLP_HICON, GCLP_HICONSM, GWLP_USERDATA, HICON, ICON_BIG, ICON_SMALL,
        IMAGE_ICON, LR_DEFAULTSIZE, LR_SHARED, MSG, SC_MAXIMIZE, SC_RESTORE, SW_SHOWMINNOACTIVE,
        WM_APP, WM_CLOSE, WM_DESTROY, WM_GETICON, WM_NCDESTROY, WM_QUERYOPEN, WM_SETICON,
        WM_SYSCOMMAND, WNDCLASSEXW, WS_EX_APPWINDOW, WS_OVERLAPPEDWINDOW,
    };

    const CLASS_NAME: PCWSTR = w!("SpektrTaskbarPlaceholderWnd");
    const WM_APP_CLOSE_SILENT: u32 = WM_APP + 42;

    static REGISTER_CLASS: Once = Once::new();

    struct PlaceholderCallbacks {
        on_restore: Box<dyn Fn() + Send + Sync>,
        on_user_close: Box<dyn Fn() + Send + Sync>,
        restore_fired: AtomicBool,
        silent_close: AtomicBool,
        icon_big: isize,
        icon_small: isize,
        hwnd_slot: Arc<AtomicIsize>,
    }

    pub struct TaskbarPlaceholder {
        hwnd: Arc<AtomicIsize>,
    }

    impl TaskbarPlaceholder {
        pub fn new() -> Self {
            Self {
                hwnd: Arc::new(AtomicIsize::new(0)),
            }
        }

        pub fn is_active(&self) -> bool {
            self.hwnd.load(Ordering::SeqCst) != 0
        }

        /// Copies the current big/small `HICON` from an existing window handle (safe across
        /// destruction of the source window).
        pub fn clone_icons_from_hwnd(source_hwnd: isize) -> (isize, isize) {
            unsafe {
                let mut big = 0isize;
                let mut small = 0isize;

                if source_hwnd != 0 {
                    let h = HWND(source_hwnd as *mut c_void);
                    let raw_big =
                        SendMessageW(h, WM_GETICON, Some(WPARAM(ICON_BIG as usize)), Some(LPARAM(0))).0;
                    let src_big = if raw_big != 0 {
                        raw_big
                    } else {
                        GetClassLongPtrW(h, GCLP_HICON) as isize
                    };
                    if src_big != 0 {
                        if let Ok(copied) = CopyIcon(HICON(src_big as *mut c_void)) {
                            big = copied.0 as isize;
                        }
                    }

                    let raw_small =
                        SendMessageW(h, WM_GETICON, Some(WPARAM(ICON_SMALL as usize)), Some(LPARAM(0))).0;
                    let src_small = if raw_small != 0 {
                        raw_small
                    } else {
                        GetClassLongPtrW(h, GCLP_HICONSM) as isize
                    };
                    if src_small != 0 {
                        if let Ok(copied) = CopyIcon(HICON(src_small as *mut c_void)) {
                            small = copied.0 as isize;
                        }
                    }
                }

                // Fallback to embedded executable icon resource (ID 32512)
                if big == 0 || small == 0 {
                    if let Ok(hmod) = GetModuleHandleW(PCWSTR::null()) {
                        let hinst = HINSTANCE(hmod.0);
                        if big == 0 {
                            if let Ok(h) = LoadImageW(
                                Some(hinst),
                                PCWSTR(32512 as *const u16),
                                IMAGE_ICON,
                                0,
                                0,
                                LR_DEFAULTSIZE | LR_SHARED,
                            ) {
                                if let Ok(copied) = CopyIcon(HICON(h.0)) {
                                    big = copied.0 as isize;
                                }
                            }
                        }
                        if small == 0 && big != 0 {
                            if let Ok(copied) = CopyIcon(HICON(big as *mut c_void)) {
                                small = copied.0 as isize;
                            }
                        }
                    }
                }

                (big, small)
            }
        }

        /// Shows a minimized native Win32 placeholder in the Taskbar. Returns `true` once
        /// the taskbar button is live.
        pub fn show<FRestore, FClose>(
            &self,
            title: &str,
            source_hwnd: isize,
            on_restore: FRestore,
            on_user_close: FClose,
        ) -> bool
        where
            FRestore: Fn() + Send + Sync + 'static,
            FClose: Fn() + Send + Sync + 'static,
        {
            if self.hwnd.load(Ordering::SeqCst) != 0 {
                return true;
            }

            let (icon_big, icon_small) = Self::clone_icons_from_hwnd(source_hwnd);
            let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
            let hwnd_slot = Arc::clone(&self.hwnd);
            let ready = Arc::new((Mutex::new(None::<bool>), Condvar::new()));
            let ready_clone = Arc::clone(&ready);

            let spawned = std::thread::Builder::new()
                .name("spektr-taskbar-placeholder".into())
                .spawn(move || unsafe {
                    let hmod = match GetModuleHandleW(PCWSTR::null()) {
                        Ok(m) => m,
                        Err(_) => {
                            destroy_icon_if_valid(icon_big);
                            destroy_icon_if_valid(icon_small);
                            signal_ready(&ready_clone, false);
                            return;
                        }
                    };
                    let hinst = HINSTANCE(hmod.0);

                    REGISTER_CLASS.call_once(|| {
                        let wc = WNDCLASSEXW {
                            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                            lpfnWndProc: Some(wnd_proc),
                            hInstance: hinst,
                            lpszClassName: CLASS_NAME,
                            ..Default::default()
                        };
                        let _ = RegisterClassExW(&wc);
                    });

                    let hwnd = match CreateWindowExW(
                        WS_EX_APPWINDOW,
                        CLASS_NAME,
                        PCWSTR(title_wide.as_ptr()),
                        WS_OVERLAPPEDWINDOW,
                        -32000,
                        -32000,
                        160,
                        28,
                        None,
                        None,
                        Some(hinst),
                        None,
                    ) {
                        Ok(h) => h,
                        Err(_) => {
                            destroy_icon_if_valid(icon_big);
                            destroy_icon_if_valid(icon_small);
                            signal_ready(&ready_clone, false);
                            return;
                        }
                    };

                    if icon_big != 0 {
                        let _ = SendMessageW(
                            hwnd,
                            WM_SETICON,
                            Some(WPARAM(ICON_BIG as usize)),
                            Some(LPARAM(icon_big)),
                        );
                    }
                    if icon_small != 0 {
                        let _ = SendMessageW(
                            hwnd,
                            WM_SETICON,
                            Some(WPARAM(ICON_SMALL as usize)),
                            Some(LPARAM(icon_small)),
                        );
                    }

                    let cb = Box::new(PlaceholderCallbacks {
                        on_restore: Box::new(on_restore),
                        on_user_close: Box::new(on_user_close),
                        restore_fired: AtomicBool::new(false),
                        silent_close: AtomicBool::new(false),
                        icon_big,
                        icon_small,
                        hwnd_slot: Arc::clone(&hwnd_slot),
                    });
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(cb) as isize);

                    // Show minimized in the Taskbar without stealing focus or flashing on screen
                    let _ = ShowWindow(hwnd, SW_SHOWMINNOACTIVE);
                    hwnd_slot.store(hwnd.0 as isize, Ordering::SeqCst);
                    signal_ready(&ready_clone, true);

                    let mut msg = MSG::default();
                    while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                });

            if spawned.is_err() {
                return false;
            }

            let (lock, cvar) = &*ready;
            let result = if let Ok(mut guard) = lock.lock() {
                while guard.is_none() {
                    guard = cvar.wait(guard).unwrap_or_else(|e| e.into_inner());
                }
                guard.unwrap_or(false)
            } else {
                false
            };
            result
        }

        /// Programmatically destroys the placeholder window without firing `on_user_close`.
        pub fn close(&self) {
            let raw = self.hwnd.swap(0, Ordering::SeqCst);
            if raw != 0 {
                unsafe {
                    let _ = PostMessageW(
                        Some(HWND(raw as *mut c_void)),
                        WM_APP_CLOSE_SILENT,
                        WPARAM(0),
                        LPARAM(0),
                    );
                }
            }
        }
    }

    impl Drop for TaskbarPlaceholder {
        fn drop(&mut self) {
            self.close();
        }
    }

    fn signal_ready(pair: &(Mutex<Option<bool>>, Condvar), ok: bool) {
        let (lock, cvar) = pair;
        if let Ok(mut guard) = lock.lock() {
            *guard = Some(ok);
            cvar.notify_all();
        }
    }

    unsafe fn destroy_icon_if_valid(icon: isize) {
        if icon != 0 {
            let _ = DestroyIcon(HICON(icon as *mut c_void));
        }
    }

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut PlaceholderCallbacks;

        match msg {
            WM_QUERYOPEN => {
                if !ptr.is_null() {
                    let cb = &*ptr;
                    if !cb.restore_fired.swap(true, Ordering::SeqCst) {
                        (cb.on_restore)();
                    }
                }
                // Returning 0 prevents the placeholder from visibly restoring on screen;
                // `on_restore` opens the real WebView window and closes this placeholder.
                return LRESULT(0);
            }
            WM_SYSCOMMAND => {
                let cmd = (wparam.0 & 0xFFF0) as u32;
                if cmd == SC_RESTORE || cmd == SC_MAXIMIZE {
                    if !ptr.is_null() {
                        let cb = &*ptr;
                        if !cb.restore_fired.swap(true, Ordering::SeqCst) {
                            (cb.on_restore)();
                        }
                    }
                    return LRESULT(0);
                }
            }
            WM_APP_CLOSE_SILENT => {
                if !ptr.is_null() {
                    let cb = &*ptr;
                    cb.silent_close.store(true, Ordering::SeqCst);
                }
                let _ = DestroyWindow(hwnd);
                return LRESULT(0);
            }
            WM_CLOSE => {
                if !ptr.is_null() {
                    let cb = &*ptr;
                    cb.hwnd_slot.store(0, Ordering::SeqCst);
                    if !cb.silent_close.load(Ordering::SeqCst) {
                        (cb.on_user_close)();
                    }
                }
                let _ = DestroyWindow(hwnd);
                return LRESULT(0);
            }
            WM_DESTROY => {
                if !ptr.is_null() {
                    let cb = &*ptr;
                    cb.hwnd_slot.store(0, Ordering::SeqCst);
                }
                PostQuitMessage(0);
                return LRESULT(0);
            }
            WM_NCDESTROY => {
                if !ptr.is_null() {
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                    let boxed = Box::from_raw(ptr);
                    boxed.hwnd_slot.store(0, Ordering::SeqCst);
                    destroy_icon_if_valid(boxed.icon_big);
                    destroy_icon_if_valid(boxed.icon_small);
                }
            }
            _ => {}
        }

        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

#[cfg(not(windows))]
mod imp {
    pub struct TaskbarPlaceholder;

    impl TaskbarPlaceholder {
        pub fn new() -> Self {
            Self
        }

        pub fn is_active(&self) -> bool {
            false
        }

        pub fn show<FRestore, FClose>(
            &self,
            _title: &str,
            _source_hwnd: isize,
            _on_restore: FRestore,
            _on_user_close: FClose,
        ) -> bool
        where
            FRestore: Fn() + Send + Sync + 'static,
            FClose: Fn() + Send + Sync + 'static,
        {
            false
        }

        pub fn close(&self) {}
    }
}

pub use imp::TaskbarPlaceholder;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_starts_inactive_and_close_is_idempotent() {
        let ph = TaskbarPlaceholder::new();
        assert!(!ph.is_active());
        ph.close();
        assert!(!ph.is_active());
    }
}
