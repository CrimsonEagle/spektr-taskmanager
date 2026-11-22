use crate::models::{ActionResult, AutostartConfig, ServiceEntry, StartupEntry};
use std::collections::HashMap;

const AUTOSTART_VALUE_NAME: &str = "Spektr Taskmanager";
const LEGACY_AUTOSTART_VALUE_NAME: &str = "Pulse Taskmanager";
const AUTOSTART_TASK_NAME: &str = "Spektr Taskmanager";
const RUN_KEY_PATH: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const STARTUP_APPROVED_RUN_PATH: &str =
    "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn normalize_autostart_mode(mode: &str) -> &'static str {
    match mode {
        "maximized" => "maximized",
        "minimized" => "minimized",
        _ => "normal",
    }
}

fn autostart_mode_args(mode: &str) -> &'static str {
    match normalize_autostart_mode(mode) {
        "maximized" => "--start-maximized",
        "minimized" => "--start-minimized",
        _ => "",
    }
}

fn xml_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

fn build_autostart_task_xml(
    user_sid: &str,
    exe_path: &str,
    working_dir: &str,
    mode: &str,
) -> String {
    let args = autostart_mode_args(mode);
    let arguments_tag = if args.is_empty() {
        String::new()
    } else {
        format!("\n      <Arguments>{}</Arguments>", xml_escape(args))
    };
    let working_dir_tag = if working_dir.is_empty() {
        String::new()
    } else {
        format!(
            "\n      <WorkingDirectory>{}</WorkingDirectory>",
            xml_escape(working_dir)
        )
    };
    let esc_sid = xml_escape(user_sid);
    let esc_exe = xml_escape(exe_path);

    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Spektr Taskmanager Autostart (Administrator)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{esc_sid}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{esc_sid}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>false</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{esc_exe}</Command>{arguments_tag}{working_dir_tag}
    </Exec>
  </Actions>
</Task>
"#
    )
}

fn decode_schtasks_output(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let u16s: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&u16s);
    }
    if bytes.len() >= 4 && bytes[1] == 0 && bytes[3] == 0 {
        let u16s: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&u16s);
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn parse_autostart_task_xml(xml: &str) -> AutostartConfig {
    let lower = xml.to_lowercase();
    let mode = if lower.contains("--start-minimized") || lower.contains("--minimized") {
        "minimized"
    } else if lower.contains("--start-maximized") || lower.contains("--maximized") {
        "maximized"
    } else {
        "normal"
    };

    let elevated = lower.contains("<runlevel>highestavailable</runlevel>");

    let settings_disabled = if let (Some(s), Some(e)) =
        (lower.find("<settings>"), lower.find("</settings>"))
    {
        if s < e {
            lower[s..e].contains("<enabled>false</enabled>")
        } else {
            false
        }
    } else {
        false
    };

    AutostartConfig {
        enabled: !settings_disabled,
        mode: mode.to_string(),
        elevated,
    }
}

#[cfg(windows)]
fn current_user_sid_string() -> Result<String, String> {
    use std::ffi::c_void;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
            .map_err(|e| format!("Benutzer-Token konnte nicht geöffnet werden: {e}"))?;

        let mut needed: u32 = 0;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
        if needed == 0 {
            let _ = CloseHandle(token);
            return Err("Benutzer-SID konnte nicht ermittelt werden.".into());
        }

        let mut buf = vec![0u8; needed as usize];
        let res = GetTokenInformation(
            token,
            TokenUser,
            Some(buf.as_mut_ptr() as *mut c_void),
            needed,
            &mut needed,
        );
        let _ = CloseHandle(token);
        res.map_err(|e| format!("Benutzer-SID konnte nicht gelesen werden: {e}"))?;

        let token_user = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut sid_pwstr = PWSTR::null();
        ConvertSidToStringSidW(token_user.User.Sid, &mut sid_pwstr)
            .map_err(|e| format!("SID-Konvertierung fehlgeschlagen: {e}"))?;

        let sid_str = sid_pwstr
            .to_string()
            .map_err(|e| format!("SID-Dekodierung fehlgeschlagen: {e}"))?;
        let _ = LocalFree(Some(HLOCAL(sid_pwstr.0 as *mut c_void)));
        Ok(sid_str)
    }
}

#[cfg(windows)]
fn quote_win_arg(arg: &str) -> String {
    if arg.is_empty() || arg.contains(' ') || arg.contains('\t') || arg.contains('"') {
        format!("\"{}\"", arg.replace('"', "\\\""))
    } else {
        arg.to_string()
    }
}

#[cfg(windows)]
fn run_schtasks(args: &[&str], require_elevation: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    if !require_elevation || crate::process_ops::is_elevated() {
        let output = Command::new("schtasks.exe")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("Aufgabenplanung (schtasks.exe) konnte nicht gestartet werden: {e}"))?;

        if output.status.success() {
            return Ok(());
        }
        let stderr = decode_schtasks_output(&output.stderr);
        let stdout = decode_schtasks_output(&output.stdout);
        let detail = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            format!("Exit-Code {:?}", output.status.code())
        };
        return Err(format!("Aufgabenplanung fehlgeschlagen: {detail}"));
    }

    // Not currently elevated -> request one-time UAC elevation for schtasks.exe only
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, ERROR_CANCELLED, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let params = args
        .iter()
        .map(|a| quote_win_arg(a))
        .collect::<Vec<_>>()
        .join(" ");
    let wide_params: Vec<u16> = params.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        let mut sei = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS,
            lpVerb: w!("runas"),
            lpFile: w!("schtasks.exe"),
            lpParameters: PCWSTR(wide_params.as_ptr()),
            nShow: SW_HIDE.0,
            ..Default::default()
        };

        if let Err(e) = ShellExecuteExW(&mut sei) {
            if e.code() == ERROR_CANCELLED.to_hresult() {
                return Err("Administrator-Freigabe (UAC) wurde abgebrochen.".into());
            }
            return Err(format!("Aufgabenplanung konnte nicht mit Adminrechten ausgeführt werden: {e}"));
        }

        if sei.hProcess.is_invalid() {
            return Err("Aufgabenplanung-Prozesshandle ungültig.".into());
        }

        let wait = WaitForSingleObject(sei.hProcess, 30_000);
        let mut exit_code: u32 = 1;
        let got_code = GetExitCodeProcess(sei.hProcess, &mut exit_code).is_ok();
        let _ = CloseHandle(sei.hProcess);

        if wait != WAIT_OBJECT_0 {
            return Err("Zeitüberschreitung beim Aktualisieren der Aufgabenplanung.".into());
        }
        if got_code && exit_code == 0 {
            Ok(())
        } else {
            Err(format!(
                "Aufgabenplanung meldete einen Fehler (Code {exit_code})."
            ))
        }
    }
}

#[cfg(windows)]
fn query_autostart_task_registry_exists() -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
    };

    let subkey = format!(
        "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Schedule\\TaskCache\\Tree\\{AUTOSTART_TASK_NAME}"
    );
    let wide: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let mut hkey = HKEY::default();
        if RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(wide.as_ptr()),
            Some(0),
            KEY_READ,
            &mut hkey,
        )
        .is_ok()
        {
            let _ = RegCloseKey(hkey);
            true
        } else {
            false
        }
    }
}

#[cfg(windows)]
fn query_autostart_task() -> Option<AutostartConfig> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    if let Ok(output) = Command::new("schtasks.exe")
        .args(["/Query", "/TN", AUTOSTART_TASK_NAME, "/XML"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        if output.status.success() {
            let xml = decode_schtasks_output(&output.stdout);
            if !xml.trim().is_empty() {
                return Some(parse_autostart_task_xml(&xml));
            }
        }
    }

    if query_autostart_task_registry_exists() {
        return Some(AutostartConfig {
            enabled: true,
            mode: "minimized".to_string(),
            elevated: true,
        });
    }

    None
}

#[cfg(windows)]
fn remove_hkcu_run_entry() {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
    };

    let wide_run_path: Vec<u16> = RUN_KEY_PATH
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let wide_name: Vec<u16> = AUTOSTART_VALUE_NAME
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let legacy_wide: Vec<u16> = LEGACY_AUTOSTART_VALUE_NAME
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let mut hkey = HKEY::default();
        if RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(wide_run_path.as_ptr()),
            Some(0),
            KEY_SET_VALUE,
            &mut hkey,
        )
        .is_ok()
        {
            let _ = RegDeleteValueW(hkey, PCWSTR(wide_name.as_ptr()));
            let _ = RegDeleteValueW(hkey, PCWSTR(legacy_wide.as_ptr()));
            let _ = RegCloseKey(hkey);
        }
    }
}

#[cfg(windows)]
fn create_elevated_autostart_task(clean_exe: &str, norm_mode: &str) -> Result<(), String> {
    let user_sid = current_user_sid_string()?;
    let working_dir = std::path::Path::new(clean_exe)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();

    let xml = build_autostart_task_xml(&user_sid, clean_exe, &working_dir, norm_mode);
    let mut utf16_bytes = Vec::with_capacity(2 + xml.len() * 2);
    utf16_bytes.extend_from_slice(&[0xFF, 0xFE]);
    for unit in xml.encode_utf16() {
        utf16_bytes.extend_from_slice(&unit.to_le_bytes());
    }

    let xml_path = std::env::temp_dir().join(format!(
        "spektr_autostart_task_{}.xml",
        std::process::id()
    ));
    std::fs::write(&xml_path, &utf16_bytes)
        .map_err(|e| format!("Temporäre Aufgaben-XML konnte nicht geschrieben werden: {e}"))?;

    let xml_path_str = xml_path.to_string_lossy().into_owned();
    let res = run_schtasks(
        &["/Create", "/TN", AUTOSTART_TASK_NAME, "/XML", &xml_path_str, "/F"],
        true,
    );
    let _ = std::fs::remove_file(&xml_path);
    res
}

#[cfg(windows)]
fn delete_autostart_task_if_present() -> Result<(), String> {
    if query_autostart_task().is_none() {
        return Ok(());
    }
    run_schtasks(&["/Delete", "/TN", AUTOSTART_TASK_NAME, "/F"], true)
}

#[cfg(windows)]
pub fn get_autostart_config() -> AutostartConfig {
    // Prefer elevated Task Scheduler logon entry when present
    if let Some(task_cfg) = query_autostart_task() {
        return task_cfg;
    }

    use std::ffi::c_void;
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ,
    };

    let wide_subkey: Vec<u16> = RUN_KEY_PATH
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let wide_name: Vec<u16> = AUTOSTART_VALUE_NAME
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    let mut buf = [0u16; 1024];
    let mut byte_len = (buf.len() * 2) as u32;

    let ok = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PCWSTR(wide_subkey.as_ptr()),
            PCWSTR(wide_name.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut c_void),
            Some(&mut byte_len),
        )
        .is_ok()
    };

    if !ok || byte_len < 2 {
        return AutostartConfig {
            enabled: false,
            mode: "minimized".to_string(),
            elevated: false,
        };
    }

    let u16_len = (byte_len as usize) / 2;
    let end = buf[..u16_len]
        .iter()
        .position(|&c| c == 0)
        .unwrap_or(u16_len);
    let cmd = String::from_utf16_lossy(&buf[..end]);
    let cmd_lower = cmd.to_lowercase();

    let mode = if cmd_lower.contains("--start-minimized") || cmd_lower.contains("--minimized") {
        "minimized"
    } else if cmd_lower.contains("--start-maximized") || cmd_lower.contains("--maximized") {
        "maximized"
    } else {
        "normal"
    };

    // Respect Windows Task Manager StartupApproved disabled flag if set
    let approved = read_startup_approved(HKEY_CURRENT_USER, STARTUP_APPROVED_RUN_PATH);
    let enabled = approved.get(AUTOSTART_VALUE_NAME).copied().unwrap_or(true);

    AutostartConfig {
        enabled,
        mode: mode.to_string(),
        elevated: false,
    }
}

#[cfg(windows)]
pub fn set_autostart_config(
    enabled: bool,
    mode: &str,
    elevated: bool,
) -> Result<AutostartConfig, String> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegSetValueExW, HKEY,
        HKEY_CURRENT_USER, KEY_SET_VALUE, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    let norm_mode = normalize_autostart_mode(mode);

    if !enabled {
        delete_autostart_task_if_present()?;
        remove_hkcu_run_entry();
        return Ok(AutostartConfig {
            enabled: false,
            mode: norm_mode.to_string(),
            elevated: false,
        });
    }

    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Programmpfad konnte nicht ermittelt werden: {e}"))?;
    let exe_str = exe_path.to_string_lossy();
    let clean_exe = exe_str.strip_prefix("\\\\?\\").unwrap_or(&exe_str);

    if elevated {
        create_elevated_autostart_task(clean_exe, norm_mode)?;
        // Remove standard HKCU Run entry so Windows does not launch Spektr twice at logon
        remove_hkcu_run_entry();
        return Ok(AutostartConfig {
            enabled: true,
            mode: norm_mode.to_string(),
            elevated: true,
        });
    }

    // Standard (non-elevated) HKCU Run entry — clean up any old elevated Task Scheduler task first
    delete_autostart_task_if_present()?;

    let wide_run_path: Vec<u16> = RUN_KEY_PATH
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let wide_name: Vec<u16> = AUTOSTART_VALUE_NAME
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    let cmd = match norm_mode {
        "maximized" => format!("\"{clean_exe}\" --start-maximized"),
        "minimized" => format!("\"{clean_exe}\" --start-minimized"),
        _ => format!("\"{clean_exe}\""),
    };

    let cmd_wide: Vec<u16> = cmd.encode_utf16().chain(std::iter::once(0)).collect();
    let cmd_bytes = unsafe {
        std::slice::from_raw_parts(
            cmd_wide.as_ptr() as *const u8,
            cmd_wide.len() * std::mem::size_of::<u16>(),
        )
    };

    unsafe {
        let mut hkey = HKEY::default();
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(wide_run_path.as_ptr()),
            Some(0),
            None,
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut hkey,
            None,
        )
        .ok()
        .map_err(|e| format!("Autostart-Registry-Schlüssel konnte nicht geöffnet werden: {e}"))?;

        let set_res = RegSetValueExW(
            hkey,
            PCWSTR(wide_name.as_ptr()),
            Some(0),
            REG_SZ,
            Some(cmd_bytes),
        )
        .ok();
        let _ = RegCloseKey(hkey);

        set_res.map_err(|e| format!("Autostart-Eintrag konnte nicht gespeichert werden: {e}"))?;

        // Clear any disabled flag in StartupApproved\Run so Windows actually runs it
        let wide_approved: Vec<u16> = STARTUP_APPROVED_RUN_PATH
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut app_key = HKEY::default();
        if RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(wide_approved.as_ptr()),
            Some(0),
            KEY_SET_VALUE,
            &mut app_key,
        )
        .is_ok()
        {
            let _ = RegDeleteValueW(app_key, PCWSTR(wide_name.as_ptr()));
            let _ = RegCloseKey(app_key);
        }
    }

    Ok(AutostartConfig {
        enabled: true,
        mode: norm_mode.to_string(),
        elevated: false,
    })
}

#[cfg(not(windows))]
pub fn get_autostart_config() -> AutostartConfig {
    AutostartConfig {
        enabled: false,
        mode: "minimized".to_string(),
        elevated: false,
    }
}

#[cfg(not(windows))]
pub fn set_autostart_config(
    _enabled: bool,
    mode: &str,
    _elevated: bool,
) -> Result<AutostartConfig, String> {
    Ok(AutostartConfig {
        enabled: false,
        mode: normalize_autostart_mode(mode).to_string(),
        elevated: false,
    })
}

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
            Some(0),
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
                Some(0),
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
                    Some(PWSTR(guid_buf.as_mut_ptr())),
                    &mut guid_len,
                    None,
                    None,
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
        if RegOpenKeyExW(root, PCWSTR(wide_subkey.as_ptr()), Some(0), KEY_READ, &mut hkey).is_err() {
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
                Some(windows::core::PWSTR(name_buf.as_mut_ptr())),
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
        if RegOpenKeyExW(root, PCWSTR(wide_subkey.as_ptr()), Some(0), KEY_READ, &mut hkey).is_err() {
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
                Some(windows::core::PWSTR(name_buf.as_mut_ptr())),
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
            Some(0),
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
            Some(0),
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
            Some(0),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autostart_task_xml_escapes_and_roundtrips() {
        let xml = build_autostart_task_xml(
            "S-1-5-21-1234-5678-9012-1001",
            r#"C:\Program Files\Spektr & Tools\spektr-taskmanager.exe"#,
            r#"C:\Program Files\Spektr & Tools"#,
            "minimized",
        );

        assert!(xml.contains("<RunLevel>HighestAvailable</RunLevel>"));
        assert!(xml.contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"));
        assert!(xml.contains("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>"));
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        assert!(xml.contains("Spektr &amp; Tools"));
        assert!(xml.contains("<Arguments>--start-minimized</Arguments>"));

        let parsed = parse_autostart_task_xml(&xml);
        assert!(parsed.enabled);
        assert!(parsed.elevated);
        assert_eq!(parsed.mode, "minimized");
    }

    #[test]
    fn parse_autostart_task_xml_detects_disabled_and_modes() {
        let xml_max = build_autostart_task_xml("S-1-5-21-1", r#"C:\app.exe"#, r#"C:\"#, "maximized")
            .replace("<Enabled>true</Enabled>\n    <Hidden>", "<Enabled>false</Enabled>\n    <Hidden>");
        let parsed_max = parse_autostart_task_xml(&xml_max);
        assert!(!parsed_max.enabled);
        assert!(parsed_max.elevated);
        assert_eq!(parsed_max.mode, "maximized");

        let xml_norm = build_autostart_task_xml("S-1-5-21-1", r#"C:\app.exe"#, r#"C:\"#, "normal");
        let parsed_norm = parse_autostart_task_xml(&xml_norm);
        assert!(parsed_norm.enabled);
        assert!(parsed_norm.elevated);
        assert_eq!(parsed_norm.mode, "normal");
    }

    #[test]
    fn decode_schtasks_output_handles_utf16le_bom() {
        let text = "<Task><RunLevel>HighestAvailable</RunLevel></Task>";
        let mut bytes = vec![0xFF, 0xFE];
        for u in text.encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(decode_schtasks_output(&bytes), text);
    }
}
