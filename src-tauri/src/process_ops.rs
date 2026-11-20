use crate::models::ActionResult;
use std::collections::{HashMap, HashSet};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
pub fn kill_process(pid: u32) -> ActionResult {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    unsafe {
        match OpenProcess(PROCESS_TERMINATE, false, pid) {
            Ok(handle) => {
                let res = TerminateProcess(handle, 1);
                let _ = CloseHandle(handle);
                match res {
                    Ok(_) => ActionResult {
                        ok: true,
                        message: format!("Prozess {pid} wurde beendet."),
                    },
                    Err(e) => ActionResult {
                        ok: false,
                        message: format!("Beenden fehlgeschlagen (evtl. Adminrechte nötig): {e}"),
                    },
                }
            }
            Err(e) => ActionResult {
                ok: false,
                message: format!("Zugriff auf Prozess {pid} verweigert: {e}"),
            },
        }
    }
}

#[cfg(windows)]
pub fn kill_process_tree(root_pid: u32, parent_map: &HashMap<u32, Option<u32>>) -> ActionResult {
    // Collect root_pid and all descendants
    let mut to_kill = vec![root_pid];
    let mut seen = HashSet::new();
    seen.insert(root_pid);

    let mut idx = 0;
    while idx < to_kill.len() {
        let current = to_kill[idx];
        idx += 1;
        for (&child_pid, &maybe_parent) in parent_map {
            if maybe_parent == Some(current) && seen.insert(child_pid) {
                to_kill.push(child_pid);
            }
        }
    }

    // Kill children first, then root
    let mut killed = 0usize;
    let mut failed = 0usize;
    for &pid in to_kill.iter().rev() {
        if kill_process(pid).ok {
            killed += 1;
        } else {
            failed += 1;
        }
    }

    if killed > 0 {
        ActionResult {
            ok: true,
            message: if failed == 0 {
                format!("Prozessbaum ({killed} Prozesse) beendet.")
            } else {
                format!("{killed} Prozesse beendet, {failed} übersprungen (Zugriff verweigert).")
            },
        }
    } else {
        ActionResult {
            ok: false,
            message: format!("Konnte Prozessbaum für PID {root_pid} nicht beenden (Adminrechte?)."),
        }
    }
}

#[cfg(windows)]
pub fn set_process_suspended(pid: u32, suspend: bool) -> ActionResult {
    use windows::core::{s, w};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SUSPEND_RESUME};

    type NtSuspendResumeFn = unsafe extern "system" fn(HANDLE) -> i32;

    unsafe {
        let Ok(ntdll) = GetModuleHandleW(w!("ntdll.dll")) else {
            return ActionResult {
                ok: false,
                message: "ntdll.dll konnte nicht geladen werden.".into(),
            };
        };

        let proc_addr = if suspend {
            GetProcAddress(ntdll, s!("NtSuspendProcess"))
        } else {
            GetProcAddress(ntdll, s!("NtResumeProcess"))
        };

        let Some(func_ptr) = proc_addr else {
            return ActionResult {
                ok: false,
                message: "Suspend/Resume API nicht verfügbar.".into(),
            };
        };

        let func: NtSuspendResumeFn = std::mem::transmute(func_ptr);

        match OpenProcess(PROCESS_SUSPEND_RESUME, false, pid) {
            Ok(handle) => {
                let status = func(handle);
                let _ = CloseHandle(handle);
                if status == 0 {
                    ActionResult {
                        ok: true,
                        message: if suspend {
                            format!("Prozess {pid} eingefroren (CPU-Last pausiert).")
                        } else {
                            format!("Prozess {pid} wird fortgesetzt.")
                        },
                    }
                } else {
                    ActionResult {
                        ok: false,
                        message: format!("Aktion fehlgeschlagen (NTSTATUS 0x{status:08X})."),
                    }
                }
            }
            Err(e) => ActionResult {
                ok: false,
                message: format!("Zugriff auf Prozess {pid} verweigert: {e}"),
            },
        }
    }
}

#[cfg(windows)]
pub fn set_process_priority(pid: u32, level: &str) -> ActionResult {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, SetPriorityClass, ABOVE_NORMAL_PRIORITY_CLASS, BELOW_NORMAL_PRIORITY_CLASS,
        HIGH_PRIORITY_CLASS, IDLE_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS, PROCESS_SET_INFORMATION,
    };

    let class = match level {
        "idle" => IDLE_PRIORITY_CLASS,
        "below_normal" => BELOW_NORMAL_PRIORITY_CLASS,
        "normal" => NORMAL_PRIORITY_CLASS,
        "above_normal" => ABOVE_NORMAL_PRIORITY_CLASS,
        "high" => HIGH_PRIORITY_CLASS,
        _ => {
            return ActionResult {
                ok: false,
                message: format!("Unbekannte Prioritätsstufe: {level}"),
            }
        }
    };

    unsafe {
        match OpenProcess(PROCESS_SET_INFORMATION, false, pid) {
            Ok(handle) => {
                let res = SetPriorityClass(handle, class);
                let _ = CloseHandle(handle);
                match res {
                    Ok(_) => ActionResult {
                        ok: true,
                        message: format!("Priorität für PID {pid} auf '{level}' gesetzt."),
                    },
                    Err(e) => ActionResult {
                        ok: false,
                        message: format!("Priorität konnte nicht geändert werden: {e}"),
                    },
                }
            }
            Err(e) => ActionResult {
                ok: false,
                message: format!("Zugriff verweigert: {e}"),
            },
        }
    }
}

#[cfg(windows)]
pub fn set_efficiency_mode(pid: u32, enable: bool) -> ActionResult {
    use std::ffi::c_void;
    use std::mem::size_of;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, ProcessPowerThrottling, SetPriorityClass, SetProcessInformation,
        IDLE_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS, PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        PROCESS_POWER_THROTTLING_EXECUTION_SPEED, PROCESS_POWER_THROTTLING_STATE,
        PROCESS_SET_INFORMATION,
    };

    unsafe {
        match OpenProcess(PROCESS_SET_INFORMATION, false, pid) {
            Ok(handle) => {
                let state = PROCESS_POWER_THROTTLING_STATE {
                    Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
                    ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
                    StateMask: if enable {
                        PROCESS_POWER_THROTTLING_EXECUTION_SPEED
                    } else {
                        0
                    },
                };

                let throttle_res = SetProcessInformation(
                    handle,
                    ProcessPowerThrottling,
                    &state as *const _ as *const c_void,
                    size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
                );

                let prio_res = SetPriorityClass(
                    handle,
                    if enable {
                        IDLE_PRIORITY_CLASS
                    } else {
                        NORMAL_PRIORITY_CLASS
                    },
                );

                let _ = CloseHandle(handle);

                if throttle_res.is_ok() || prio_res.is_ok() {
                    ActionResult {
                        ok: true,
                        message: if enable {
                            format!("Eco-Modus (Efficiency Mode) für PID {pid} aktiviert.")
                        } else {
                            format!("Eco-Modus für PID {pid} deaktiviert.")
                        },
                    }
                } else {
                    ActionResult {
                        ok: false,
                        message: "Eco-Modus konnte für diesen Prozess nicht geändert werden.".into(),
                    }
                }
            }
            Err(e) => ActionResult {
                ok: false,
                message: format!("Zugriff verweigert: {e}"),
            },
        }
    }
}

#[cfg(windows)]
pub fn get_process_handle_count(pid: u32) -> Option<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        GetProcessHandleCount, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut count: u32 = 0;
        let ok = GetProcessHandleCount(handle, &mut count).is_ok();
        let _ = CloseHandle(handle);
        if ok {
            Some(count)
        } else {
            None
        }
    }
}

#[cfg(not(windows))]
pub fn get_process_handle_count(_pid: u32) -> Option<u32> {
    None
}

pub fn open_file_location(exe_path: &str) -> ActionResult {
    if exe_path.trim().is_empty() {
        return ActionResult {
            ok: false,
            message: "Kein Dateipfad für diesen Prozess verfügbar.".into(),
        };
    }

    let res = Command::new("explorer.exe")
        .arg(format!("/select,{}", exe_path))
        .spawn();

    match res {
        Ok(_) => ActionResult {
            ok: true,
            message: "Speicherort im Explorer geöffnet.".into(),
        },
        Err(e) => ActionResult {
            ok: false,
            message: format!("Explorer konnte nicht geöffnet werden: {e}"),
        },
    }
}

pub fn restart_explorer() -> ActionResult {
    let mut kill = Command::new("taskkill");
    kill.args(["/F", "/IM", "explorer.exe"]);
    #[cfg(windows)]
    kill.creation_flags(CREATE_NO_WINDOW);
    let _ = kill.output();

    std::thread::sleep(std::time::Duration::from_millis(350));

    match Command::new("explorer.exe").spawn() {
        Ok(_) => ActionResult {
            ok: true,
            message: "Windows Explorer wurde neu gestartet.".into(),
        },
        Err(e) => ActionResult {
            ok: false,
            message: format!("Explorer-Neustart fehlgeschlagen: {e}"),
        },
    }
}

#[cfg(windows)]
pub fn get_process_priority(pid: u32) -> Result<String, String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        GetPriorityClass, OpenProcess, ABOVE_NORMAL_PRIORITY_CLASS, BELOW_NORMAL_PRIORITY_CLASS,
        HIGH_PRIORITY_CLASS, IDLE_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS,
        PROCESS_QUERY_LIMITED_INFORMATION, REALTIME_PRIORITY_CLASS,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
            .map_err(|e| format!("Zugriff auf Prozess {pid} verweigert: {e}"))?;
        let class = GetPriorityClass(handle);
        let _ = CloseHandle(handle);

        if class == 0 {
            return Err(format!("Priorität für PID {pid} konnte nicht gelesen werden."));
        }

        let label = if class == IDLE_PRIORITY_CLASS.0 {
            "idle"
        } else if class == BELOW_NORMAL_PRIORITY_CLASS.0 {
            "below_normal"
        } else if class == NORMAL_PRIORITY_CLASS.0 {
            "normal"
        } else if class == ABOVE_NORMAL_PRIORITY_CLASS.0 {
            "above_normal"
        } else if class == HIGH_PRIORITY_CLASS.0 {
            "high"
        } else if class == REALTIME_PRIORITY_CLASS.0 {
            "realtime"
        } else {
            "normal"
        };

        Ok(label.to_string())
    }
}

#[cfg(not(windows))]
pub fn get_process_priority(_pid: u32) -> Result<String, String> {
    Ok("normal".to_string())
}

#[cfg(windows)]
pub fn is_elevated() -> bool {
    use std::ffi::c_void;
    use std::sync::OnceLock;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    static ELEVATED: OnceLock<bool> = OnceLock::new();
    *ELEVATED.get_or_init(|| unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut ret_len: u32 = 0;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut ret_len,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok && elevation.TokenIsElevated != 0
    })
}

#[cfg(not(windows))]
pub fn is_elevated() -> bool {
    false
}

#[cfg(windows)]
pub fn restart_as_admin() -> Result<(), String> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let exe = std::env::current_exe()
        .map_err(|e| format!("Pfad zur Anwendung konnte nicht ermittelt werden: {e}"))?;
    let exe_str = exe.to_string_lossy();
    let wide_exe: Vec<u16> = exe_str.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        let res = ShellExecuteW(
            None,
            w!("runas"),
            PCWSTR(wide_exe.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
        if (res.0 as isize) > 32 {
            Ok(())
        } else {
            Err("Administrator-Neustart abgebrochen oder fehlgeschlagen.".into())
        }
    }
}

#[cfg(not(windows))]
pub fn restart_as_admin() -> Result<(), String> {
    Err("Nur unter Windows unterstützt.".into())
}

#[cfg(windows)]
pub fn restart_process(pid: u32, exe_path: &str, cmd_line: &str) -> Result<u32, String> {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        CreateProcessW, OpenProcess, TerminateProcess, WaitForSingleObject,
        PROCESS_CREATION_FLAGS, PROCESS_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        STARTUPINFOW,
    };

    let exe_trimmed = exe_path.trim();
    let cmd_trimmed = cmd_line.trim();
    if exe_trimmed.is_empty() && cmd_trimmed.is_empty() {
        return Err("Kein ausführbarer Pfad für diesen Prozess verfügbar.".into());
    }

    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, false, pid)
            .map_err(|e| format!("Zugriff auf Prozess {pid} verweigert: {e}"))?;
        let term_res = TerminateProcess(handle, 1);
        if term_res.is_ok() {
            let _ = WaitForSingleObject(handle, 500);
        }
        let _ = CloseHandle(handle);
        term_res.map_err(|e| format!("Beenden von Prozess {pid} fehlgeschlagen: {e}"))?;

        let launch_cmd = if cmd_trimmed.is_empty() {
            format!("\"{exe_trimmed}\"")
        } else {
            cmd_trimmed.to_string()
        };

        let exe_wide: Option<Vec<u16>> = if !exe_trimmed.is_empty() {
            Some(
                exe_trimmed
                    .encode_utf16()
                    .chain(std::iter::once(0))
                    .collect(),
            )
        } else {
            None
        };
        let mut cmd_wide: Vec<u16> = launch_cmd
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        let si = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            ..Default::default()
        };
        let mut pi = PROCESS_INFORMATION::default();

        let app_ptr = exe_wide
            .as_ref()
            .map(|w| PCWSTR(w.as_ptr()))
            .unwrap_or(PCWSTR::null());

        CreateProcessW(
            app_ptr,
            PWSTR(cmd_wide.as_mut_ptr()),
            None,
            None,
            false,
            PROCESS_CREATION_FLAGS(0),
            None,
            PCWSTR::null(),
            &si,
            &mut pi,
        )
        .map_err(|e| format!("Neustart fehlgeschlagen: {e}"))?;

        let new_pid = pi.dwProcessId;
        let _ = CloseHandle(pi.hThread);
        let _ = CloseHandle(pi.hProcess);
        Ok(new_pid)
    }
}

#[cfg(not(windows))]
pub fn restart_process(_pid: u32, _exe_path: &str, _cmd_line: &str) -> Result<u32, String> {
    Err("Nur unter Windows unterstützt.".into())
}

#[cfg(windows)]
pub fn trim_working_set(pid: u32) -> Result<u64, String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::ProcessStatus::{
        K32EmptyWorkingSet, K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
    };

    unsafe {
        let handle = OpenProcess(
            PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION,
            false,
            pid,
        )
        .map_err(|e| format!("Zugriff auf Prozess {pid} verweigert: {e}"))?;

        let mut before_pmc = PROCESS_MEMORY_COUNTERS {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            ..Default::default()
        };
        let before_ok = K32GetProcessMemoryInfo(handle, &mut before_pmc, before_pmc.cb).as_bool();
        let before = if before_ok {
            before_pmc.WorkingSetSize as u64
        } else {
            0
        };

        let trimmed = K32EmptyWorkingSet(handle).as_bool();
        if !trimmed {
            let _ = CloseHandle(handle);
            return Err(format!("Working-Set für PID {pid} konnte nicht getrimmt werden."));
        }

        let mut after_pmc = PROCESS_MEMORY_COUNTERS {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            ..Default::default()
        };
        let after_ok = K32GetProcessMemoryInfo(handle, &mut after_pmc, after_pmc.cb).as_bool();
        let after = if after_ok {
            after_pmc.WorkingSetSize as u64
        } else {
            before
        };

        let _ = CloseHandle(handle);
        Ok(before.saturating_sub(after))
    }
}

#[cfg(not(windows))]
pub fn trim_working_set(_pid: u32) -> Result<u64, String> {
    Err("Nur unter Windows unterstützt.".into())
}

#[cfg(windows)]
pub fn run_new_task(command: &str) -> Result<(), String> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("Bitte gib einen Befehl oder Dateipfad ein.".into());
    }

    let (program, args) = if let Some(rest) = trimmed.strip_prefix('"') {
        if let Some(end_quote) = rest.find('"') {
            (&rest[..end_quote], rest[end_quote + 1..].trim())
        } else {
            (rest, "")
        }
    } else if let Some(idx) = trimmed.find(char::is_whitespace) {
        (&trimmed[..idx], trimmed[idx..].trim())
    } else {
        (trimmed, "")
    };

    if program.is_empty() {
        return Err("Ungültiger Befehl.".into());
    }

    let prog_wide: Vec<u16> = program.encode_utf16().chain(std::iter::once(0)).collect();
    let args_wide: Option<Vec<u16>> = if args.is_empty() {
        None
    } else {
        Some(args.encode_utf16().chain(std::iter::once(0)).collect())
    };

    unsafe {
        let res = ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(prog_wide.as_ptr()),
            args_wide
                .as_ref()
                .map(|w| PCWSTR(w.as_ptr()))
                .unwrap_or(PCWSTR::null()),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
        if (res.0 as isize) > 32 {
            Ok(())
        } else {
            Err(format!(
                "Aufgabe '{program}' konnte nicht gestartet werden (Code {}).",
                res.0 as isize
            ))
        }
    }
}

#[cfg(not(windows))]
pub fn run_new_task(_command: &str) -> Result<(), String> {
    Err("Nur unter Windows unterstützt.".into())
}

// ============================================================================
// CPU Affinity & P-/E-Core Topology
// ============================================================================
#[cfg(windows)]
fn cached_cpu_topology() -> &'static (Vec<crate::models::CpuCoreInfo>, bool) {
    use std::sync::OnceLock;
    use windows::Win32::System::SystemInformation::{
        GetLogicalProcessorInformationEx, RelationProcessorCore, PROCESSOR_RELATIONSHIP,
        SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX,
    };

    static TOPOLOGY: OnceLock<(Vec<crate::models::CpuCoreInfo>, bool)> = OnceLock::new();
    TOPOLOGY.get_or_init(|| {
        let mut cores = Vec::new();
        unsafe {
            let mut len: u32 = 0;
            let _ = GetLogicalProcessorInformationEx(RelationProcessorCore, None, &mut len);
            if len > 0 {
                let mut buf = vec![0u8; len as usize];
                if GetLogicalProcessorInformationEx(
                    RelationProcessorCore,
                    Some(buf.as_mut_ptr() as *mut SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX),
                    &mut len,
                )
                .is_ok()
                {
                    let mut offset = 0usize;
                    let mut physical_id = 0u32;
                    let total_len = len as usize;
                    let min_proc_entry = 8 + std::mem::size_of::<PROCESSOR_RELATIONSHIP>();
                    while offset + 8 <= total_len {
                        let ptr = buf.as_ptr().add(offset);
                        let info = &*(ptr as *const SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX);
                        let entry_size = info.Size as usize;
                        if entry_size < 8 || offset + entry_size > total_len {
                            break;
                        }
                        if info.Relationship == RelationProcessorCore && entry_size >= min_proc_entry
                        {
                            let proc_rel = &info.Anonymous.Processor;
                            let eff = proc_rel.EfficiencyClass;
                            if proc_rel.GroupCount > 0 {
                                let group = proc_rel.GroupMask[0];
                                // Group 0 covers logical processors 0..63 (ProcessAffinityMask)
                                if group.Group == 0 {
                                    let mask = group.Mask as u64;
                                    for bit in 0..64u32 {
                                        if (mask & (1u64 << bit)) != 0 {
                                            cores.push(crate::models::CpuCoreInfo {
                                                index: bit,
                                                core_id: physical_id,
                                                efficiency_class: eff,
                                                is_p_core: true,
                                            });
                                        }
                                    }
                                }
                            }
                            physical_id += 1;
                        }
                        offset = offset.saturating_add(entry_size);
                    }
                }
            }
        }

        cores.sort_by_key(|c| c.index);
        let min_eff = cores.iter().map(|c| c.efficiency_class).min().unwrap_or(0);
        let max_eff = cores.iter().map(|c| c.efficiency_class).max().unwrap_or(0);
        let has_hybrid = max_eff > min_eff;
        if has_hybrid {
            for c in &mut cores {
                c.is_p_core = c.efficiency_class == max_eff;
            }
        }
        (cores, has_hybrid)
    })
}

#[cfg(windows)]
pub fn get_process_affinity(pid: u32) -> Result<crate::models::ProcessAffinityInfo, String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        GetProcessAffinityMask, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let (cores, has_hybrid) = cached_cpu_topology();

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
            .map_err(|e| format!("Zugriff auf Prozess {pid} verweigert: {e}"))?;
        let mut proc_mask: usize = 0;
        let mut sys_mask: usize = 0;
        let res = GetProcessAffinityMask(handle, &mut proc_mask, &mut sys_mask);
        let _ = CloseHandle(handle);
        res.map_err(|e| format!("Affinität für PID {pid} konnte nicht gelesen werden: {e}"))?;

        Ok(crate::models::ProcessAffinityInfo {
            pid,
            process_mask: proc_mask as u64,
            system_mask: sys_mask as u64,
            cores: cores.clone(),
            has_hybrid_cores: *has_hybrid,
        })
    }
}

#[cfg(not(windows))]
pub fn get_process_affinity(pid: u32) -> Result<crate::models::ProcessAffinityInfo, String> {
    Ok(crate::models::ProcessAffinityInfo {
        pid,
        process_mask: 1,
        system_mask: 1,
        cores: Vec::new(),
        has_hybrid_cores: false,
    })
}

#[cfg(windows)]
pub fn set_process_affinity(pid: u32, mask: u64) -> Result<(), String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, SetProcessAffinityMask, PROCESS_SET_INFORMATION,
    };

    if mask == 0 {
        return Err("Mindestens ein CPU-Kern muss ausgewählt bleiben.".into());
    }

    unsafe {
        let handle = OpenProcess(PROCESS_SET_INFORMATION, false, pid)
            .map_err(|e| format!("Zugriff auf Prozess {pid} verweigert: {e}"))?;
        let res = SetProcessAffinityMask(handle, mask as usize);
        let _ = CloseHandle(handle);
        res.map_err(|e| format!("CPU-Affinität für PID {pid} konnte nicht gesetzt werden: {e}"))
    }
}

#[cfg(not(windows))]
pub fn set_process_affinity(_pid: u32, _mask: u64) -> Result<(), String> {
    Err("Nur unter Windows unterstützt.".into())
}

// ============================================================================
// Window Picker ("Crosshair") — zero idle cost after completion
// ============================================================================
#[cfg(windows)]
pub fn pick_window_pid_blocking() -> Result<Option<u32>, String> {
    use std::time::Duration;
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE, VK_LBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetCursorPos, GetWindowThreadProcessId, WindowFromPoint, GA_ROOT,
    };

    let self_pid = std::process::id();

    unsafe {
        // Wait briefly until the initial mouse click (on the picker button) is released
        for _ in 0..50 {
            if (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) == 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(30));
        }

        // Poll at 40ms intervals for up to 30 seconds
        for _ in 0..750 {
            if (GetAsyncKeyState(VK_ESCAPE.0 as i32) as u16 & 0x8000) != 0 {
                return Ok(None);
            }

            if (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 {
                let mut pt = POINT::default();
                if GetCursorPos(&mut pt).is_ok() {
                    let hwnd = WindowFromPoint(pt);
                    if !hwnd.is_invalid() {
                        let root = GetAncestor(hwnd, GA_ROOT);
                        let target = if root.is_invalid() { hwnd } else { root };
                        let mut pid: u32 = 0;
                        let _ = GetWindowThreadProcessId(target, Some(&mut pid));
                        if pid != 0 && pid != self_pid {
                            return Ok(Some(pid));
                        }
                    }
                }
                // Wait for button release before retrying if user clicked Pulse itself
                for _ in 0..40 {
                    if (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) == 0 {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
            }

            std::thread::sleep(Duration::from_millis(40));
        }
    }

    Ok(None)
}

#[cfg(not(windows))]
pub fn pick_window_pid_blocking() -> Result<Option<u32>, String> {
    Ok(None)
}
