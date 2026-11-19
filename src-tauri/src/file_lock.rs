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

    let wide_path: Vec<u16> = trimmed.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        let mut session: u32 = 0;
        let mut session_key = [0u16; 64];
        let start_res = RmStartSession(&mut session, 0, PWSTR(session_key.as_mut_ptr()));
        if start_res.0 != 0 {
            return Err(format!(
                "Restart Manager Sitzung konnte nicht gestartet werden (Code {}).",
                start_res.0
            ));
        }

        let files = [PCWSTR(wide_path.as_ptr())];
        let reg_res = RmRegisterResources(session, Some(&files), None, None);
        if reg_res.0 != 0 {
            let _ = RmEndSession(session);
            return Err(format!(
                "Datei konnte nicht geprüft werden (Code {}). Prüfe ob der Pfad existiert.",
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

#[cfg(not(windows))]
pub fn find_file_locks(
    _file_path: &str,
    _proc_names: &HashMap<u32, String>,
) -> Result<Vec<FileLockEntry>, String> {
    Ok(Vec::new())
}
