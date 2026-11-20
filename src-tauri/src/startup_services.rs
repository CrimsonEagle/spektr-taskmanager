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

    // Read-only Task Scheduler Logon & Boot triggers from Registry (zero subprocesses)
    items.extend(read_task_scheduler_startup());

    items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    items
}

#[cfg(windows)]
fn read_task_scheduler_startup() -> Vec<StartupEntry> {
    use std::collections::HashSet;
    use std::ffi::c_void;
    use windows::core::{w, PCWSTR, PWSTR};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE,
        KEY_READ, RRF_RT_REG_SZ,
    };

    let mut results = Vec::new();
    let mut seen_ids = HashSet::new();

    unsafe {
        let mut tasks_root = HKEY::default();
        if RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            w!("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Schedule\\TaskCache\\Tasks"),
            0,
            KEY_READ,
            &mut tasks_root,
        )
        .is_err()
        {
            return results;
        }

        let triggers = [
            (
                "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Schedule\\TaskCache\\Logon",
                "Benutzer (Logon)",
            ),
            (
                "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Schedule\\TaskCache\\Boot",
                "System (Boot)",
            ),
        ];

        for (subkey_path, scope_label) in triggers {
            let wide_sub: Vec<u16> = subkey_path
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let mut trig_key = HKEY::default();
            if RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                PCWSTR(wide_sub.as_ptr()),
                0,
                KEY_READ,
                &mut trig_key,
            )
            .is_err()
            {
                continue;
            }

            let mut idx = 0u32;
            loop {
                let mut guid_buf = [0u16; 128];
                let mut guid_len = guid_buf.len() as u32;
                let res = RegEnumKeyExW(
                    trig_key,
                    idx,
                    PWSTR(guid_buf.as_mut_ptr()),
                    &mut guid_len,
                    None,
                    PWSTR::null(),
                    None,
                    None,
                );
                if res.is_err() {
                    break;
                }
                idx += 1;
                if guid_len == 0 {
                    continue;
                }

                let guid_str = String::from_utf16_lossy(&guid_buf[..guid_len as usize]);
                let guid_wide: Vec<u16> =
                    guid_str.encode_utf16().chain(std::iter::once(0)).collect();

                let mut path_buf = [0u16; 512];
                let mut path_bytes = (path_buf.len() * 2) as u32;
                let got_path = RegGetValueW(
                    tasks_root,
                    PCWSTR(guid_wide.as_ptr()),
                    w!("Path"),
                    RRF_RT_REG_SZ,
                    None,
                    Some(path_buf.as_mut_ptr() as *mut c_void),
                    Some(&mut path_bytes),
                )
                .is_ok();

                if !got_path || path_bytes < 2 {
                    continue;
                }
                let u16_len = (path_bytes as usize) / 2;
                let end = path_buf[..u16_len]
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(u16_len);
                let task_path = String::from_utf16_lossy(&path_buf[..end]).trim().to_string();
                if task_path.is_empty() {
                    continue;
                }

                let id = format!("task::{task_path}");
                if !seen_ids.insert(id.clone()) {
                    continue;
                }

                let display_name = task_path
                    .rsplit('\\')
                    .next()
                    .filter(|s| !s.is_empty())
                    .unwrap_or(&task_path)
                    .to_string();

                results.push(StartupEntry {
                    id,
                    name: display_name,
                    command: task_path,
                    location: "Task Scheduler".to_string(),
                    scope: scope_label.to_string(),
                    enabled: true,
                    registry_subkey: "TaskScheduler".to_string(),
                });
            }

            let _ = RegCloseKey(trig_key);
        }

        let _ = RegCloseKey(tasks_root);
    }

    results
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

                // Open HKLM\SYSTEM\CurrentControlSet\Services once for fast read-only start_type lookups (no admin needed)
                let services_key = open_services_registry_key();

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
                    let start_type = services_key
                        .as_ref()
                        .and_then(|&hk| read_service_start_type(hk, &name));

                    list.push(ServiceEntry {
                        name,
                        display_name,
                        status,
                        pid,
                        start_type,
                    });
                }

                if let Some(hk) = services_key {
                    let _ = windows::Win32::System::Registry::RegCloseKey(hk);
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
fn open_services_registry_key() -> Option<windows::Win32::System::Registry::HKEY> {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ};

    unsafe {
        let mut hkey = HKEY::default();
        if RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            w!("SYSTEM\\CurrentControlSet\\Services"),
            0,
            KEY_READ,
            &mut hkey,
        )
        .is_ok()
        {
            Some(hkey)
        } else {
            None
        }
    }
}

#[cfg(windows)]
fn read_service_start_type(
    services_root: windows::Win32::System::Registry::HKEY,
    service_name: &str,
) -> Option<String> {
    use std::ffi::c_void;
    use windows::core::{w, PCWSTR};
    use windows::Win32::System::Registry::{RegGetValueW, RRF_RT_REG_DWORD};

    let wide_subkey: Vec<u16> = service_name
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut start_val: u32 = 0;
    let mut data_len: u32 = std::mem::size_of::<u32>() as u32;

    unsafe {
        let res = RegGetValueW(
            services_root,
            PCWSTR(wide_subkey.as_ptr()),
            w!("Start"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut start_val as *mut u32 as *mut c_void),
            Some(&mut data_len),
        );
        if res.is_err() {
            return None;
        }
    }

    match start_val {
        2 => Some("auto".to_string()),
        3 => Some("manual".to_string()),
        4 => Some("disabled".to_string()),
        _ => None,
    }
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

#[cfg(windows)]
pub fn set_service_start_type(service_name: &str, start_type: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Services::{
        ChangeServiceConfigW, CloseServiceHandle, OpenSCManagerW, OpenServiceW, ENUM_SERVICE_TYPE,
        SC_MANAGER_CONNECT, SERVICE_AUTO_START, SERVICE_CHANGE_CONFIG, SERVICE_DEMAND_START,
        SERVICE_DISABLED, SERVICE_ERROR, SERVICE_NO_CHANGE,
    };

    let win_start_type = match start_type {
        "auto" => SERVICE_AUTO_START,
        "manual" => SERVICE_DEMAND_START,
        "disabled" => SERVICE_DISABLED,
        _ => return Err(format!("Unbekannter Starttyp: {start_type}")),
    };

    let wide_name: Vec<u16> = service_name
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let scm = OpenSCManagerW(None, None, SC_MANAGER_CONNECT)
            .map_err(|e| format!("Dienst-Manager konnte nicht geöffnet werden: {e}"))?;

        let service = match OpenServiceW(scm, PCWSTR(wide_name.as_ptr()), SERVICE_CHANGE_CONFIG) {
            Ok(s) => s,
            Err(e) => {
                let _ = CloseServiceHandle(scm);
                return Err(format!(
                    "Zugriff auf Dienst '{service_name}' verweigert (Administratorrechte erforderlich): {e}"
                ));
            }
        };

        let res = ChangeServiceConfigW(
            service,
            ENUM_SERVICE_TYPE(SERVICE_NO_CHANGE),
            win_start_type,
            SERVICE_ERROR(SERVICE_NO_CHANGE),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );

        let _ = CloseServiceHandle(service);
        let _ = CloseServiceHandle(scm);

        res.map_err(|e| format!("Starttyp für '{service_name}' konnte nicht geändert werden: {e}"))
    }
}

#[cfg(not(windows))]
pub fn set_service_start_type(_service_name: &str, _start_type: &str) -> Result<(), String> {
    Err("Nur unter Windows unterstützt.".into())
}
