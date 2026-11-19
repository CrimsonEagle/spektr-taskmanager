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
