use crate::models::{ActionResult, ServiceEntry, StartupEntry};
use std::collections::HashMap;

#[cfg(windows)]
pub fn list_startup_entries() -> Vec<StartupEntry> {
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    let mut items = Vec::new();

    let approved_hkcu = read_startup_approved(
        HKEY_CURRENT_USER,
        "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run",
    );
    let approved_hklm = read_startup_approved(
        HKEY_LOCAL_MACHINE,
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run",
    );

    items.extend(read_run_key(
        HKEY_CURRENT_USER,
        "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
        "HKCU\\...\\Run",
        "Benutzer",
        &approved_hkcu,
    ));

    items.extend(read_run_key(
        HKEY_LOCAL_MACHINE,
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run",
        "HKLM\\...\\Run",
        "System",
        &approved_hklm,
    ));

    items.extend(read_run_key(
        HKEY_LOCAL_MACHINE,
        "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run",
        "HKLM\\WOW6432\\Run",
        "System (32-Bit)",
        &approved_hklm,
    ));

    // Also inspect current user Startup folder
    if let Ok(appdata) = std::env::var("APPDATA") {
        let folder = std::path::PathBuf::from(appdata)
            .join("Microsoft\\Windows\\Start Menu\\Programs\\Startup");
        if let Ok(entries) = std::fs::read_dir(&folder) {
            let approved_folder = read_startup_approved(
                HKEY_CURRENT_USER,
                "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder",
            );
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(fname) = path.file_name().and_then(|s| s.to_str()) {
                    if fname.eq_ignore_ascii_case("desktop.ini") {
                        continue;
                    }
                    let enabled = approved_folder.get(fname).copied().unwrap_or(true);
                    items.push(StartupEntry {
                        id: format!("folder::{}", fname),
                        name: fname.to_string(),
                        command: path.to_string_lossy().to_string(),
                        location: "Autostart-Ordner".to_string(),
                        scope: "Benutzer".to_string(),
                        enabled,
                        registry_subkey: "StartupFolder".to_string(),
                    });
                }
            }
        }
    }

    items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    items
}

#[cfg(windows)]
fn read_startup_approved(
    root: windows::Win32::System::Registry::HKEY,
    subkey: &str,
) -> HashMap<String, bool> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumValueW, RegOpenKeyExW, HKEY, KEY_READ, REG_VALUE_TYPE,
    };

    let mut map = HashMap::new();
    let wide_subkey: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        let mut hkey = HKEY::default();
        if RegOpenKeyExW(root, PCWSTR(wide_subkey.as_ptr()), 0, KEY_READ, &mut hkey).is_err() {
            return map;
        }

        let mut index = 0u32;
        loop {
            let mut name_buf = [0u16; 260];
            let mut name_len = name_buf.len() as u32;
            let mut data_buf = [0u8; 64];
            let mut data_len = data_buf.len() as u32;
            let mut value_type = REG_VALUE_TYPE::default();

            let res = RegEnumValueW(
                hkey,
                index,
                windows::core::PWSTR(name_buf.as_mut_ptr()),
                &mut name_len,
                None,
                Some(&mut value_type.0),
                Some(data_buf.as_mut_ptr()),
                Some(&mut data_len),
            );
            if res.is_err() {
                break;
            }
            index += 1;

            let name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
            if data_len >= 1 {
                // Windows StartupApproved: 0x02 / 0x06 = enabled, 0x03 / 0x07 = disabled (odd = disabled, even = enabled)
                let first_byte = data_buf[0];
                let enabled = (first_byte & 1) == 0;
                map.insert(name, enabled);
            }
        }
        let _ = RegCloseKey(hkey);
    }
    map
}

#[cfg(windows)]
fn read_run_key(
    root: windows::Win32::System::Registry::HKEY,
    subkey: &str,
    location_label: &str,
    scope: &str,
    approved: &HashMap<String, bool>,
) -> Vec<StartupEntry> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumValueW, RegOpenKeyExW, HKEY, KEY_READ, REG_VALUE_TYPE,
    };

    let mut entries = Vec::new();
    let wide_subkey: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        let mut hkey = HKEY::default();
        if RegOpenKeyExW(root, PCWSTR(wide_subkey.as_ptr()), 0, KEY_READ, &mut hkey).is_err() {
            return entries;
        }

        let mut index = 0u32;
        loop {
            let mut name_buf = [0u16; 260];
            let mut name_len = name_buf.len() as u32;
            let mut data_buf = [0u8; 2048];
            let mut data_len = data_buf.len() as u32;
            let mut value_type = REG_VALUE_TYPE::default();

            let res = RegEnumValueW(
                hkey,
                index,
                windows::core::PWSTR(name_buf.as_mut_ptr()),
                &mut name_len,
                None,
                Some(&mut value_type.0),
                Some(data_buf.as_mut_ptr()),
                Some(&mut data_len),
            );
            if res.is_err() {
                break;
            }
            index += 1;

            let name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
            if name.is_empty() {
                continue;
            }

            let u16_slice = std::slice::from_raw_parts(
                data_buf.as_ptr() as *const u16,
                (data_len as usize) / 2,
            );
            let end = u16_slice
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(u16_slice.len());
            let command = String::from_utf16_lossy(&u16_slice[..end]);

            let enabled = approved.get(&name).copied().unwrap_or(true);

            entries.push(StartupEntry {
                id: format!("{}::{}", scope, name),
                name,
                command,
                location: location_label.to_string(),
                scope: scope.to_string(),
                enabled,
                registry_subkey: if scope == "Benutzer" {
                    "HKCU_Run".to_string()
                } else {
                    "HKLM_Run".to_string()
                },
            });
        }

        let _ = RegCloseKey(hkey);
    }
    entries
}

#[cfg(windows)]
pub fn toggle_startup_entry(name: &str, registry_subkey: &str, enable: bool) -> ActionResult {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
        KEY_WRITE, REG_BINARY, REG_OPTION_NON_VOLATILE,
    };

    let (root, path) = match registry_subkey {
        "HKCU_Run" => (
            HKEY_CURRENT_USER,
            "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run",
        ),
        "StartupFolder" => (
            HKEY_CURRENT_USER,
            "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder",
        ),
        _ => (
            HKEY_LOCAL_MACHINE,
            "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run",
        ),
    };

    let wide_path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let wide_name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();

    // Standard 12-byte Windows StartupApproved binary value
    let mut payload = [0u8; 12];
    payload[0] = if enable { 0x02 } else { 0x03 };

    unsafe {
        let mut hkey = HKEY::default();
        let open_res = RegCreateKeyExW(
            root,
            PCWSTR(wide_path.as_ptr()),
            0,
            None,
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut hkey,
            None,
        );

        if let Err(e) = open_res.ok() {
            return ActionResult {
                ok: false,
                message: format!(
                    "Autostart-Status konnte nicht geändert werden (für System-Einträge Adminrechte nötig): {e}"
                ),
            };
        }

        let set_res = RegSetValueExW(
            hkey,
            PCWSTR(wide_name.as_ptr()),
            0,
            REG_BINARY,
            Some(&payload),
        );
        let _ = RegCloseKey(hkey);

        match set_res.ok() {
            Ok(_) => ActionResult {
                ok: true,
                message: if enable {
                    format!("Autostart für '{name}' aktiviert.")
                } else {
                    format!("Autostart für '{name}' deaktiviert.")
                },
            },
            Err(e) => ActionResult {
                ok: false,
                message: format!("Änderung fehlgeschlagen: {e}"),
            },
        }
    }
}

#[cfg(windows)]
pub fn list_services() -> Vec<ServiceEntry> {
    use windows::Win32::System::Services::{
        CloseServiceHandle, EnumServicesStatusExW, OpenSCManagerW, ENUM_SERVICE_STATUS_PROCESSW,
        SC_ENUM_PROCESS_INFO, SC_MANAGER_ENUMERATE_SERVICE, SERVICE_PAUSED, SERVICE_RUNNING,
        SERVICE_START_PENDING, SERVICE_STATE_ALL, SERVICE_STOPPED, SERVICE_STOP_PENDING,
        SERVICE_WIN32,
    };

    let mut list = Vec::new();
    unsafe {
        let Ok(scm) = OpenSCManagerW(None, None, SC_MANAGER_ENUMERATE_SERVICE) else {
            return list;
        };

        let mut bytes_needed: u32 = 0;
        let mut services_returned: u32 = 0;
        let mut resume_handle: u32 = 0;

        let _ = EnumServicesStatusExW(
            scm,
            SC_ENUM_PROCESS_INFO,
            SERVICE_WIN32,
            SERVICE_STATE_ALL,
            None,
            &mut bytes_needed,
            &mut services_returned,
            Some(&mut resume_handle),
            None,
        );

        if bytes_needed > 0 {
            let mut buffer = vec![0u8; bytes_needed as usize];
            if EnumServicesStatusExW(
                scm,
                SC_ENUM_PROCESS_INFO,
                SERVICE_WIN32,
                SERVICE_STATE_ALL,
                Some(&mut buffer),
                &mut bytes_needed,
                &mut services_returned,
                Some(&mut resume_handle),
                None,
            )
            .is_ok()
            {
                let entries = std::slice::from_raw_parts(
                    buffer.as_ptr() as *const ENUM_SERVICE_STATUS_PROCESSW,
                    services_returned as usize,
                );

                for svc in entries {
                    let name = svc
                        .lpServiceName
                        .to_string()
                        .unwrap_or_default();
                    let display_name = svc
                        .lpDisplayName
                        .to_string()
                        .unwrap_or_else(|_| name.clone());
                    let status = match svc.ServiceStatusProcess.dwCurrentState {
                        SERVICE_RUNNING => "Aktiv",
                        SERVICE_STOPPED => "Gestoppt",
                        SERVICE_PAUSED => "Pausiert",
                        SERVICE_START_PENDING => "Startet...",
                        SERVICE_STOP_PENDING => "Stoppt...",
                        _ => "Unbekannt",
                    }
                    .to_string();
                    let pid = if svc.ServiceStatusProcess.dwProcessId > 0 {
                        Some(svc.ServiceStatusProcess.dwProcessId)
                    } else {
                        None
                    };

                    list.push(ServiceEntry {
                        name,
                        display_name,
                        status,
                        pid,
                    });
                }
            }
        }

        let _ = CloseServiceHandle(scm);
    }

    list.sort_by(|a, b| {
        let a_running = a.status == "Aktiv";
        let b_running = b.status == "Aktiv";
        b_running
            .cmp(&a_running)
            .then_with(|| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()))
    });
    list
}

#[cfg(windows)]
pub fn control_service(service_name: &str, action: &str) -> ActionResult {
    use windows::core::PCWSTR;
    use windows::Win32::System::Services::{
        CloseServiceHandle, ControlService, OpenSCManagerW, OpenServiceW, StartServiceW,
        SC_MANAGER_CONNECT, SERVICE_CONTROL_STOP, SERVICE_START, SERVICE_STATUS, SERVICE_STOP,
    };

    let wide_name: Vec<u16> = service_name
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let Ok(scm) = OpenSCManagerW(None, None, SC_MANAGER_CONNECT) else {
            return ActionResult {
                ok: false,
                message: "Dienst-Manager konnte nicht geöffnet werden.".into(),
            };
        };

        let access = match action {
            "start" => SERVICE_START,
            "stop" => SERVICE_STOP,
            "restart" => SERVICE_START | SERVICE_STOP,
            _ => {
                let _ = CloseServiceHandle(scm);
                return ActionResult {
                    ok: false,
                    message: format!("Unbekannte Dienst-Aktion: {action}"),
                };
            }
        };

        let Ok(service) = OpenServiceW(scm, PCWSTR(wide_name.as_ptr()), access) else {
            let _ = CloseServiceHandle(scm);
            return ActionResult {
                ok: false,
                message: format!(
                    "Zugriff auf Dienst '{service_name}' verweigert (Administratorrechte erforderlich)."
                ),
            };
        };

        let result = match action {
            "start" => match StartServiceW(service, None) {
                Ok(_) => ActionResult {
                    ok: true,
                    message: format!("Dienst '{service_name}' wird gestartet."),
                },
                Err(e) => ActionResult {
                    ok: false,
                    message: format!("Start fehlgeschlagen: {e}"),
                },
            },
            "stop" => {
                let mut status = SERVICE_STATUS::default();
                match ControlService(service, SERVICE_CONTROL_STOP, &mut status) {
                    Ok(_) => ActionResult {
                        ok: true,
                        message: format!("Dienst '{service_name}' wird gestoppt."),
                    },
                    Err(e) => ActionResult {
                        ok: false,
                        message: format!("Stop fehlgeschlagen: {e}"),
                    },
                }
            }
            "restart" => {
                let mut status = SERVICE_STATUS::default();
                let _ = ControlService(service, SERVICE_CONTROL_STOP, &mut status);
                std::thread::sleep(std::time::Duration::from_millis(800));
                match StartServiceW(service, None) {
                    Ok(_) => ActionResult {
                        ok: true,
                        message: format!("Dienst '{service_name}' wurde neu gestartet."),
                    },
                    Err(e) => ActionResult {
                        ok: false,
                        message: format!("Neustart fehlgeschlagen: {e}"),
                    },
                }
            }
            _ => ActionResult {
                ok: false,
                message: "Ungültige Aktion.".into(),
            },
        };

        let _ = CloseServiceHandle(service);
        let _ = CloseServiceHandle(scm);
        result
    }
}
