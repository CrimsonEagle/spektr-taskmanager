mod file_lock;
mod gpu;
mod models;
mod network;
mod process_ops;
mod startup_services;
mod telemetry;

use models::{
    ActionResult, FileLockEntry, HistoryPoint, NetworkConnectionEntry, ServiceEntry, StartupEntry,
    TelemetrySnapshot,
};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};
use telemetry::TelemetryEngine;

pub struct AppState {
    pub engine: Arc<Mutex<Option<TelemetryEngine>>>,
    pub latest: Arc<Mutex<Option<TelemetrySnapshot>>>,
    pub refresh_ms: Arc<Mutex<u64>>,
}

#[tauri::command]
fn get_snapshot(state: State<'_, AppState>) -> Option<TelemetrySnapshot> {
    state.latest.lock().ok().and_then(|g| g.clone())
}

#[tauri::command]
fn get_history(state: State<'_, AppState>) -> Vec<HistoryPoint> {
    state
        .engine
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|e| e.history()))
        .unwrap_or_default()
}

#[tauri::command]
fn set_refresh_interval(ms: u64, state: State<'_, AppState>) -> ActionResult {
    let clamped = ms.clamp(500, 5000);
    if let Ok(mut guard) = state.refresh_ms.lock() {
        *guard = clamped;
    }
    ActionResult {
        ok: true,
        message: format!("Aktualisierungsrate auf {} ms gesetzt.", clamped),
    }
}

#[tauri::command]
fn kill_process(pid: u32) -> ActionResult {
    process_ops::kill_process(pid)
}

#[tauri::command]
fn kill_process_tree(pid: u32, state: State<'_, AppState>) -> ActionResult {
    let parent_map = state
        .engine
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|e| e.parent_map()))
        .unwrap_or_default();
    process_ops::kill_process_tree(pid, &parent_map)
}

#[tauri::command]
fn set_process_suspended(pid: u32, suspend: bool, state: State<'_, AppState>) -> ActionResult {
    let res = process_ops::set_process_suspended(pid, suspend);
    if res.ok {
        if let Ok(mut guard) = state.engine.lock() {
            if let Some(engine) = guard.as_mut() {
                engine.set_suspended_flag(pid, suspend);
            }
        }
    }
    res
}

#[tauri::command]
fn set_process_priority(pid: u32, level: String) -> ActionResult {
    process_ops::set_process_priority(pid, &level)
}

#[tauri::command]
fn set_efficiency_mode(pid: u32, enable: bool, state: State<'_, AppState>) -> ActionResult {
    let res = process_ops::set_efficiency_mode(pid, enable);
    if res.ok {
        if let Ok(mut guard) = state.engine.lock() {
            if let Some(engine) = guard.as_mut() {
                engine.set_efficiency_flag(pid, enable);
            }
        }
    }
    res
}

#[tauri::command]
fn open_file_location(exe_path: String) -> ActionResult {
    process_ops::open_file_location(&exe_path)
}

#[tauri::command]
fn restart_explorer() -> ActionResult {
    process_ops::restart_explorer()
}

#[tauri::command]
fn apply_quick_profile(profile: String, state: State<'_, AppState>) -> ActionResult {
    let self_pid = std::process::id();
    let targets: Vec<(u32, String)> = state
        .latest
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .map(|snap| {
            snap.processes
                .into_iter()
                .filter(|p| p.pid != self_pid && p.category != "system")
                .map(|p| (p.pid, p.category))
                .collect()
        })
        .unwrap_or_default();

    let mut adjusted = 0usize;
    match profile.as_str() {
        "eco" => {
            for (pid, cat) in &targets {
                if cat == "background" || cat == "browser" {
                    if process_ops::set_efficiency_mode(*pid, true).ok {
                        adjusted += 1;
                        if let Ok(mut guard) = state.engine.lock() {
                            if let Some(eng) = guard.as_mut() {
                                eng.set_efficiency_flag(*pid, true);
                            }
                        }
                    }
                }
            }
        }
        "gaming" => {
            for (pid, cat) in &targets {
                if cat == "background" {
                    if process_ops::set_process_priority(*pid, "below_normal").ok {
                        adjusted += 1;
                    }
                } else if cat == "game" {
                    if process_ops::set_process_priority(*pid, "high").ok {
                        adjusted += 1;
                    }
                }
            }
        }
        _ => {
            for (pid, _) in &targets {
                if process_ops::set_efficiency_mode(*pid, false).ok {
                    adjusted += 1;
                    if let Ok(mut guard) = state.engine.lock() {
                        if let Some(eng) = guard.as_mut() {
                            eng.set_efficiency_flag(*pid, false);
                        }
                    }
                }
            }
        }
    }

    if let Ok(mut guard) = state.engine.lock() {
        if let Some(eng) = guard.as_mut() {
            eng.set_active_profile(profile.clone());
        }
    }

    let label = match profile.as_str() {
        "eco" => format!("Eco-Profil aktiv ({adjusted} Hintergrundprozesse gedrosselt)."),
        "gaming" => format!("Gaming-Profil aktiv ({adjusted} Prozesse optimiert)."),
        _ => format!("Standard-Profil wiederhergestellt ({adjusted} Prozesse normalisiert)."),
    };

    ActionResult {
        ok: true,
        message: label,
    }
}

#[tauri::command]
fn get_network_connections(state: State<'_, AppState>) -> Vec<NetworkConnectionEntry> {
    let lookup = state
        .engine
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|e| e.process_lookup()))
        .unwrap_or_default();
    network::list_connections(&lookup)
}

#[tauri::command]
fn check_file_locks(path: String, state: State<'_, AppState>) -> Result<Vec<FileLockEntry>, String> {
    let names = state
        .engine
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|e| e.process_name_map()))
        .unwrap_or_default();
    file_lock::find_file_locks(&path, &names)
}

#[tauri::command]
fn get_startup_entries() -> Vec<StartupEntry> {
    startup_services::list_startup_entries()
}

#[tauri::command]
fn toggle_startup_entry(name: String, registry_subkey: String, enable: bool) -> ActionResult {
    startup_services::toggle_startup_entry(&name, &registry_subkey, enable)
}

#[tauri::command]
fn get_services() -> Vec<ServiceEntry> {
    startup_services::list_services()
}

#[tauri::command]
fn control_service(name: String, action: String) -> ActionResult {
    startup_services::control_service(&name, &action)
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "Pulse öffnen", true, None::<&str>)?;
    let hud_item = MenuItem::with_id(app, "hud", "Mini-HUD umschalten", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show_item, &hud_item, &quit_item])?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Pulse — Task Manager")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
            }
            "hud" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.emit("toggle-mini-hud", ());
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    let _ = builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Keep the main UI thread 100% free of MTA COM/WMI/DXGI calls so Tauri's OleInitialize (STA) succeeds.
    let engine: Arc<Mutex<Option<TelemetryEngine>>> = Arc::new(Mutex::new(None));
    let latest: Arc<Mutex<Option<TelemetrySnapshot>>> = Arc::new(Mutex::new(None));
    let refresh_ms = Arc::new(Mutex::new(1000u64));

    let bg_engine = Arc::clone(&engine);
    let bg_latest = Arc::clone(&latest);
    let bg_refresh = Arc::clone(&refresh_ms);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            engine,
            latest,
            refresh_ms,
        })
        .setup(move |app| {
            let _ = setup_tray(app.handle());

            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("pulse-telemetry".into())
                .spawn(move || {
                    let mut eng = TelemetryEngine::new();
                    // Short warm-up sleep so initial CPU delta is accurate
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    let first_snap = eng.collect();
                    if let Ok(mut lat) = bg_latest.lock() {
                        *lat = Some(first_snap.clone());
                    }
                    if let Ok(mut guard) = bg_engine.lock() {
                        *guard = Some(eng);
                    }
                    let _ = handle.emit("telemetry-update", &first_snap);

                    loop {
                        let delay = bg_refresh.lock().map(|g| *g).unwrap_or(1000);
                        std::thread::sleep(std::time::Duration::from_millis(delay));

                        let snap_opt = bg_engine
                            .lock()
                            .ok()
                            .and_then(|mut guard| guard.as_mut().map(|e| e.collect()));

                        if let Some(snap) = snap_opt {
                            if let Ok(mut lat) = bg_latest.lock() {
                                *lat = Some(snap.clone());
                            }
                            let _ = handle.emit("telemetry-update", &snap);
                        }
                    }
                })
                .expect("Telemetrie-Thread konnte nicht gestartet werden");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            get_history,
            set_refresh_interval,
            kill_process,
            kill_process_tree,
            set_process_suspended,
            set_process_priority,
            set_efficiency_mode,
            open_file_location,
            restart_explorer,
            apply_quick_profile,
            get_network_connections,
            check_file_locks,
            get_startup_entries,
            toggle_startup_entry,
            get_services,
            control_service,
        ])
        .run(tauri::generate_context!())
        .expect("Fehler beim Starten von Pulse Task Manager");
}
