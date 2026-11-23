use crate::models::FileLockEntry;
use std::collections::HashMap;

#[cfg(windows)]
pub fn find_file_locks(
    file_path: &str,
    proc_names: &HashMap<u32, String>,
) -> Result<Vec<FileLockEntry>, String> {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::ERROR_MORE_DATA;
    use windows::Win32::System::RestartManager::{
        RmEndSession, RmGetList, RmRegisterResources, RmStartSession, RM_APP_TYPE, RM_PROCESS_INFO,
    };

    let trimmed = file_path.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err("Bitte gib einen gültigen Dateipfad an.".into());
    }

    const MAX_DIR_FILES: usize = 500;
    let target = std::path::Path::new(trimmed);
    let wide_paths: Vec<Vec<u16>> = if target.is_dir() {
        let mut collected = Vec::new();
        let mut stack = vec![target.to_path_buf()];
        while let Some(dir) = stack.pop() {
            if collected.len() >= MAX_DIR_FILES {
                break;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                if collected.len() >= MAX_DIR_FILES {
                    break;
                }
                let Ok(ft) = entry.file_type() else {
                    continue;
                };
                if ft.is_symlink() {
                    continue;
                }
                let path = entry.path();
                if ft.is_dir() {
                    stack.push(path);
                } else if ft.is_file() {
                    let s = path.to_string_lossy();
                    collected.push(s.encode_utf16().chain(std::iter::once(0)).collect());
                }
            }
        }
        if collected.is_empty() {
            return Ok(Vec::new());
        }
        collected
    } else {
        vec![trimmed.encode_utf16().chain(std::iter::once(0)).collect()]
    };

    unsafe {
        let mut session: u32 = 0;
        let mut session_key = [0u16; 64];
        let start_res = RmStartSession(&mut session, Some(0), PWSTR(session_key.as_mut_ptr()));
        if start_res.0 != 0 {
            return Err(format!(
                "Restart Manager Sitzung konnte nicht gestartet werden (Code {}).",
                start_res.0
            ));
        }

        let files: Vec<PCWSTR> = wide_paths.iter().map(|w| PCWSTR(w.as_ptr())).collect();
        let reg_res = RmRegisterResources(session, Some(&files), None, None);
        if reg_res.0 != 0 {
            let _ = RmEndSession(session);
            return Err(format!(
                "Datei/Ordner konnte nicht geprüft werden (Code {}). Prüfe ob der Pfad existiert.",
                reg_res.0
            ));
        }

        let mut needed: u32 = 0;
        let mut count: u32 = 0;
        let mut reboot_reasons: u32 = 0;

        let first = RmGetList(
            session,
            &mut needed,
            &mut count,
            None,
            &mut reboot_reasons,
        );

        let mut results = Vec::new();
        let mut seen_pids = std::collections::HashSet::new();
        if first == ERROR_MORE_DATA && needed > 0 {
            let mut infos = vec![RM_PROCESS_INFO::default(); needed as usize];
            count = needed;
            let second = RmGetList(
                session,
                &mut needed,
                &mut count,
                Some(infos.as_mut_ptr()),
                &mut reboot_reasons,
            );
            if second.0 == 0 {
                for info in infos.into_iter().take(count as usize) {
                    let pid = info.Process.dwProcessId;
                    if !seen_pids.insert(pid) {
                        continue;
                    }
                    let app_name = utf16_slice_to_string(&info.strAppName);
                    let service_short_name = utf16_slice_to_string(&info.strServiceShortName);
                    let app_type = match info.ApplicationType {
                        RM_APP_TYPE(1) => "Desktop-App",
                        RM_APP_TYPE(2) => "Anwendung",
                        RM_APP_TYPE(3) => "Windows-Dienst",
                        RM_APP_TYPE(4) => "Windows Explorer",
                        RM_APP_TYPE(5) => "Konsole",
                        RM_APP_TYPE(1000) => "Kritisch",
                        _ => "Prozess",
                    }
                    .to_string();

                    let process_name = proc_names
                        .get(&pid)
                        .cloned()
                        .unwrap_or_else(|| app_name.clone());

                    results.push(FileLockEntry {
                        pid,
                        app_name: if app_name.is_empty() {
                            process_name.clone()
                        } else {
                            app_name
                        },
                        service_short_name,
                        app_type,
                        process_name,
                    });
                }
            }
        }

        let _ = RmEndSession(session);
        Ok(results)
    }
}

#[cfg(windows)]
fn utf16_slice_to_string(slice: &[u16]) -> String {
    let end = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());
    String::from_utf16_lossy(&slice[..end]).trim().to_string()
}

#[cfg(windows)]
pub fn read_clipboard_file_path() -> Result<Option<String>, String> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    const CF_UNICODETEXT: u32 = 13;
    const CF_HDROP: u32 = 15;

    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    unsafe {
        let mut opened = false;
        for _ in 0..3 {
            if OpenClipboard(None).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        if !opened {
            return Err("Zwischenablage konnte nicht geöffnet werden.".into());
        }
        let _guard = ClipboardGuard;

        // 1. Prefer CF_HDROP (files or folders copied via Ctrl+C in Windows Explorer)
        if IsClipboardFormatAvailable(CF_HDROP).is_ok() {
            if let Ok(handle) = GetClipboardData(CF_HDROP) {
                let hdrop = HDROP(handle.0);
                let count = DragQueryFileW(hdrop, 0xFFFF_FFFF, None);
                if count > 0 {
                    let len = DragQueryFileW(hdrop, 0, None);
                    if len > 0 {
                        let mut buf = vec![0u16; (len + 1) as usize];
                        let written = DragQueryFileW(hdrop, 0, Some(&mut buf));
                        if written > 0 {
                            let path = String::from_utf16_lossy(&buf[..written as usize]);
                            let trimmed = path.trim().trim_matches('"');
                            if !trimmed.is_empty() {
                                return Ok(Some(trimmed.to_string()));
                            }
                        }
                    }
                }
            }
        }

        // 2. Fallback to CF_UNICODETEXT ("Copy as path" Ctrl+Shift+C or manually copied path)
        if IsClipboardFormatAvailable(CF_UNICODETEXT).is_ok() {
            if let Ok(handle) = GetClipboardData(CF_UNICODETEXT) {
                let hglobal = HGLOBAL(handle.0);
                let ptr = GlobalLock(hglobal) as *const u16;
                if !ptr.is_null() {
                    let mut len = 0usize;
                    while *ptr.add(len) != 0 && len < 32_768 {
                        len += 1;
                    }
                    let slice = std::slice::from_raw_parts(ptr, len);
                    let raw = String::from_utf16_lossy(slice);
                    let _ = GlobalUnlock(hglobal);

                    if let Some(first_line) = raw.lines().map(str::trim).find(|l| !l.is_empty()) {
                        let candidate = first_line.trim_matches('"').trim();
                        if !candidate.is_empty() && std::path::Path::new(candidate).exists() {
                            return Ok(Some(candidate.to_string()));
                        }
                    }
                }
            }
        }
    }

    Ok(None)
}

#[cfg(not(windows))]
pub fn find_file_locks(
    _file_path: &str,
    _proc_names: &HashMap<u32, String>,
) -> Result<Vec<FileLockEntry>, String> {
    Ok(Vec::new())
}

#[cfg(not(windows))]
pub fn read_clipboard_file_path() -> Result<Option<String>, String> {
    Ok(None)
}
