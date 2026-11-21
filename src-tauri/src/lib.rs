mod cpu_sensors;
mod disk_sensors;
mod file_lock;
mod gpu;
mod icons;
mod models;
mod net_etw;
mod network;
mod process_inspect;
mod process_ops;
mod rules;
mod startup_services;
mod telemetry;
mod tray_icon;
mod win_cpu;

use models::{
    ActionResult, AutostartConfig, FileLockEntry, HistoryPoint, NetworkConnectionEntry,
    ProcessAffinityInfo, ProcessEnvInfo, ProcessModulesThreads, ProcessRule, ProcessSecurityInfo,
    ServiceEntry, StartupEntry, TelemetrySnapshot,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};
use telemetry::TelemetryEngine;

#[derive(Debug, Clone)]
pub struct UiState {
    pub visible: bool,
    pub active_tab: String,
    pub mini_hud: bool,
    pub palette_open: bool,
    pub inspected_pid: Option<u32>,
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            visible: true,
            active_tab: "overview".to_string(),
            mini_hud: false,
            palette_open: false,
            inspected_pid: None,
        }
    }
}

pub struct AppState {
    pub engine: Arc<Mutex<Option<TelemetryEngine>>>,
    pub latest: Arc<Mutex<Option<Arc<TelemetrySnapshot>>>>,
    pub refresh_ms: Arc<Mutex<u64>>,
    pub ui_state: Arc<Mutex<UiState>>,
    pub wake_signal: Arc<(Mutex<u64>, Condvar)>,
    pub paused: Arc<AtomicBool>,
    pub minimize_to_tray: Arc<AtomicBool>,
    pub tray_cpu_icon: Arc<AtomicBool>,
    pub rule_store: Arc<Mutex<rules::RuleStore>>,
}

fn trigger_wake(wake_signal: &(Mutex<u64>, Condvar)) {
    let (lock, cvar) = wake_signal;
    if let Ok(mut gen) = lock.lock() {
        *gen = gen.wrapping_add(1);
        cvar.notify_all();
    }
}

#[tauri::command]
fn get_snapshot(state: State<'_, AppState>) -> Option<TelemetrySnapshot> {
    state
        .latest
        .lock()
        .ok()
        .and_then(|g| g.as_deref().cloned())
}

#[tauri::command]
fn set_ui_state(
    state: State<'_, AppState>,
    visible: bool,
    active_tab: String,
    mini_hud: bool,
    palette_open: bool,
    inspected_pid: Option<u32>,
) -> Result<(), String> {
    let should_wake = {
        let mut guard = state
            .ui_state
            .lock()
            .map_err(|_| "UI-State Lock fehlgeschlagen".to_string())?;
        let was_idle = !guard.visible && !guard.mini_hud;
        let became_active = visible || mini_hud;
        let hud_changed = guard.mini_hud != mini_hud;
        guard.visible = visible;
        guard.active_tab = active_tab;
        guard.mini_hud = mini_hud;
        guard.palette_open = palette_open;
        guard.inspected_pid = inspected_pid;
        (was_idle && became_active) || hud_changed
    };
    if should_wake {
        trigger_wake(&state.wake_signal);
    }
    Ok(())
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
    trigger_wake(&state.wake_signal);
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
    let snap_arc = state.latest.lock().ok().and_then(|g| g.clone());
    let procs = snap_arc
        .as_deref()
        .map(|snap| snap.processes.as_slice())
        .unwrap_or(&[]);

    let (boosted, other_count) = state
        .engine
        .lock()
        .ok()
        .and_then(|mut guard| guard.as_mut().map(|eng| eng.apply_profile(&profile, procs)))
        .unwrap_or((0, 0));

    let label = match profile.as_str() {
        "eco" => format!(
            "Eco-Profil aktiv ({other_count} gedrosselt) — neue Hintergrund-Apps werden automatisch verwaltet."
        ),
        "gaming" => format!(
            "Boost-Profil aktiv ({boosted} geboostet, {other_count} gedrosselt) — neue Spiele & 3D-Apps werden automatisch priorisiert."
        ),
        _ => format!("Standard-Profil wiederhergestellt ({other_count} Prozesse zurückgesetzt)."),
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
fn get_autostart_config() -> AutostartConfig {
    startup_services::get_autostart_config()
}

#[tauri::command]
fn set_autostart_config(enabled: bool, mode: String) -> Result<AutostartConfig, String> {
    startup_services::set_autostart_config(enabled, &mode)
}

#[tauri::command]
fn get_services() -> Vec<ServiceEntry> {
    startup_services::list_services()
}

#[tauri::command]
fn set_telemetry_paused(state: State<'_, AppState>, paused: bool) -> Result<(), String> {
    let was_paused = state.paused.swap(paused, Ordering::Relaxed);
    if was_paused && !paused {
        trigger_wake(&state.wake_signal);
    }
    Ok(())
}

#[tauri::command]
fn set_minimize_to_tray(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    state.minimize_to_tray.store(enabled, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn set_tray_cpu_icon(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    state.tray_cpu_icon.store(enabled, Ordering::Relaxed);
    if !enabled {
        if let Some(tray) = app.tray_by_id("main-tray") {
            if let Some(icon) = app.default_window_icon() {
                let _ = tray.set_icon(Some(icon.clone()));
            }
        }
    } else {
        trigger_wake(&state.wake_signal);
    }
    Ok(())
}

#[tauri::command]
fn set_mini_hud(app: AppHandle, enabled: bool, height: Option<f64>) -> Result<(), String> {
    let Some(win) = app.get_webview_window("main") else {
        return Err("Hauptfenster nicht gefunden.".into());
    };
    if enabled {
        let h = height.unwrap_or(240.0).clamp(150.0, 440.0);
        let _ = win.unmaximize();
        let _ = win.set_min_size(Some(tauri::LogicalSize::new(340.0, 140.0)));
        let _ = win.set_size(tauri::LogicalSize::new(390.0, h));
        let _ = win.set_always_on_top(true);
        let _ = win.set_resizable(false);
    } else {
        let _ = win.set_always_on_top(false);
        let _ = win.set_resizable(true);
        let _ = win.set_min_size(Some(tauri::LogicalSize::new(960.0, 640.0)));
        let _ = win.set_size(tauri::LogicalSize::new(1340.0, 860.0));
    }
    Ok(())
}

#[tauri::command]
fn get_process_priority(pid: u32) -> Result<String, String> {
    process_ops::get_process_priority(pid)
}

#[tauri::command]
fn is_elevated() -> bool {
    process_ops::is_elevated()
}

#[tauri::command]
fn restart_as_admin(app: AppHandle) -> Result<(), String> {
    process_ops::restart_as_admin()?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn set_service_start_type(name: String, start_type: String) -> Result<(), String> {
    startup_services::set_service_start_type(&name, &start_type)
}

#[tauri::command]
fn restart_process(pid: u32, exe_path: String, cmd_line: String) -> Result<u32, String> {
    process_ops::restart_process(pid, &exe_path, &cmd_line)
}

#[tauri::command]
fn trim_working_set(pid: u32) -> Result<u64, String> {
    process_ops::trim_working_set(pid)
}

#[tauri::command]
fn run_new_task(command: String) -> Result<(), String> {
    process_ops::run_new_task(&command)
}

#[tauri::command]
fn export_report(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("Export fehlgeschlagen: {e}"))
}

#[tauri::command]
fn get_process_affinity(pid: u32) -> Result<ProcessAffinityInfo, String> {
    process_ops::get_process_affinity(pid)
}

#[tauri::command]
fn set_process_affinity(pid: u32, mask: u64) -> Result<(), String> {
    process_ops::set_process_affinity(pid, mask)
}

#[tauri::command]
async fn pick_window_pid(app: AppHandle) -> Result<Option<u32>, String> {
    let picked = tauri::async_runtime::spawn_blocking(process_ops::pick_window_pid_blocking)
        .await
        .map_err(|e| format!("Window-Picker fehlgeschlagen: {e}"))??;
    if picked.is_some() {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
    }
    Ok(picked)
}

#[tauri::command]
async fn get_process_security_info(exe_path: String) -> Result<ProcessSecurityInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        process_inspect::get_process_security_info(&exe_path)
    })
    .await
    .map_err(|e| format!("Sicherheitsprüfung fehlgeschlagen: {e}"))?
}

#[tauri::command]
fn get_process_modules_and_threads(pid: u32) -> Result<ProcessModulesThreads, String> {
    process_inspect::get_process_modules_and_threads(pid)
}

#[tauri::command]
fn get_process_env_info(pid: u32) -> Result<ProcessEnvInfo, String> {
    process_inspect::get_process_env_info(pid)
}

#[tauri::command]
fn list_process_rules(state: State<'_, AppState>) -> Vec<ProcessRule> {
    state
        .rule_store
        .lock()
        .map(|s| s.list())
        .unwrap_or_default()
}

#[tauri::command]
fn save_process_rule(
    state: State<'_, AppState>,
    rule: ProcessRule,
) -> Result<Vec<ProcessRule>, String> {
    let mut guard = state
        .rule_store
        .lock()
        .map_err(|_| "Rule-Store Lock fehlgeschlagen".to_string())?;
    guard.save_rule(rule)
}

#[tauri::command]
fn delete_process_rule(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<ProcessRule>, String> {
    let mut guard = state
        .rule_store
        .lock()
        .map_err(|_| "Rule-Store Lock fehlgeschlagen".to_string())?;
    guard.delete_rule(&id)
}

#[tauri::command]
fn close_tcp_connection(
    local_addr: String,
    local_port: u16,
    remote_addr: String,
    remote_port: u16,
) -> Result<(), String> {
    network::close_tcp_connection(&local_addr, local_port, &remote_addr, remote_port)
}

#[tauri::command]
async fn resolve_reverse_dns(ip: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || network::resolve_reverse_dns(&ip))
        .await
        .map_err(|e| format!("Reverse-DNS fehlgeschlagen: {e}"))?
}

#[tauri::command]
fn get_process_icons(paths: Vec<String>) -> std::collections::HashMap<String, String> {
    icons::get_process_icons(paths)
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

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip("Pulse Taskmanager")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
                trigger_wake(&app.state::<AppState>().wake_signal);
            }
            "hud" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.emit("toggle-mini-hud", ());
                }
                trigger_wake(&app.state::<AppState>().wake_signal);
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
                trigger_wake(&app.state::<AppState>().wake_signal);
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
    let latest: Arc<Mutex<Option<Arc<TelemetrySnapshot>>>> = Arc::new(Mutex::new(None));
    let refresh_ms = Arc::new(Mutex::new(1000u64));
    let ui_state = Arc::new(Mutex::new(UiState::default()));
    let wake_signal = Arc::new((Mutex::new(0u64), Condvar::new()));
    let paused = Arc::new(AtomicBool::new(false));
    let minimize_to_tray = Arc::new(AtomicBool::new(false));
    let tray_cpu_icon = Arc::new(AtomicBool::new(true));
    let rule_store = Arc::new(Mutex::new(rules::RuleStore::load(None)));

    let bg_engine = Arc::clone(&engine);
    let bg_latest = Arc::clone(&latest);
    let bg_refresh = Arc::clone(&refresh_ms);
    let bg_ui_state = Arc::clone(&ui_state);
    let bg_wake = Arc::clone(&wake_signal);
    let bg_paused = Arc::clone(&paused);
    let bg_tray_cpu_icon = Arc::clone(&tray_cpu_icon);
    let bg_rules = Arc::clone(&rule_store);
    let setup_rules = Arc::clone(&rule_store);
    let setup_ui_state = Arc::clone(&ui_state);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            engine,
            latest,
            refresh_ms,
            ui_state,
            wake_signal,
            paused,
            minimize_to_tray,
            tray_cpu_icon,
            rule_store,
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let state = window.state::<AppState>();
                    if state.minimize_to_tray.load(Ordering::Relaxed) {
                        api.prevent_close();
                        let _ = window.hide();
                        trigger_wake(&state.wake_signal);
                    }
                }
            }
        })
        .setup(move |app| {
            let _ = setup_tray(app.handle());

            // Apply requested startup window mode (normal / maximized / minimized to tray)
            let args: Vec<String> = std::env::args().collect();
            let start_minimized = args
                .iter()
                .any(|a| a == "--start-minimized" || a == "--minimized" || a == "--tray");
            let start_maximized = !start_minimized
                && args
                    .iter()
                    .any(|a| a == "--start-maximized" || a == "--maximized");

            if start_minimized {
                if let Ok(mut ui) = setup_ui_state.lock() {
                    ui.visible = false;
                }
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.hide();
                }
            } else if let Some(win) = app.get_webview_window("main") {
                if start_maximized {
                    let _ = win.maximize();
                }
                let _ = win.show();
                let _ = win.set_focus();
            }

            if let Ok(data_dir) = app.path().app_data_dir() {
                let rules_path = data_dir.join("process_rules.json");
                if let Ok(mut guard) = setup_rules.lock() {
                    *guard = rules::RuleStore::load(Some(rules_path));
                }
            }

            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("pulse-telemetry".into())
                .spawn(move || {
                    let mut eng = TelemetryEngine::new();
                    // Short warm-up sleep so initial CPU delta is accurate
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    let first_snap = Arc::new(eng.collect());
                    if let Ok(mut lat) = bg_latest.lock() {
                        *lat = Some(Arc::clone(&first_snap));
                    }
                    if let Ok(mut guard) = bg_engine.lock() {
                        *guard = Some(eng);
                    }
                    let _ = handle.emit("telemetry-update", first_snap.as_ref());

                    let mut last_wake_gen = 0u64;
                    let mut loop_tick: u64 = 0;
                    let mut last_tooltip = String::new();
                    let mut tray_cpu_hist = [0u8; 14];
                    let mut last_tray_icon_state: Option<([u8; 14], u8)> = None;

                    loop {
                        if bg_paused.load(Ordering::Relaxed) {
                            let (lock, cvar) = &*bg_wake;
                            if let Ok(mut gen_guard) = lock.lock() {
                                while bg_paused.load(Ordering::Relaxed)
                                    && *gen_guard == last_wake_gen
                                {
                                    gen_guard = cvar
                                        .wait(gen_guard)
                                        .unwrap_or_else(|e| e.into_inner());
                                }
                                last_wake_gen = *gen_guard;
                            }
                            if bg_paused.load(Ordering::Relaxed) {
                                continue;
                            }
                        }

                        let (ui_visible, mini_hud) = bg_ui_state
                            .lock()
                            .map(|u| (u.visible, u.mini_hud))
                            .unwrap_or((true, false));

                        let win_hidden_or_min = handle
                            .get_webview_window("main")
                            .map(|w| {
                                let vis = w.is_visible().unwrap_or(true);
                                let min = w.is_minimized().unwrap_or(false);
                                !vis || min
                            })
                            .unwrap_or(false);

                        let is_idle = (!ui_visible || win_hidden_or_min) && !mini_hud;
                        let base_delay = bg_refresh.lock().map(|g| *g).unwrap_or(1000);
                        let delay_ms = if is_idle {
                            base_delay.max(4000)
                        } else {
                            base_delay
                        };

                        let (lock, cvar) = &*bg_wake;
                        if let Ok(mut gen_guard) = lock.lock() {
                            if *gen_guard == last_wake_gen {
                                let (new_guard, _) = cvar
                                    .wait_timeout(
                                        gen_guard,
                                        std::time::Duration::from_millis(delay_ms),
                                    )
                                    .unwrap_or_else(|e| e.into_inner());
                                gen_guard = new_guard;
                            }
                            last_wake_gen = *gen_guard;
                        }

                        if bg_paused.load(Ordering::Relaxed) {
                            continue;
                        }

                        let snap_opt = bg_engine
                            .lock()
                            .ok()
                            .and_then(|mut guard| guard.as_mut().map(|e| e.collect()));

                        if let Some(snap) = snap_opt {
                            loop_tick = loop_tick.wrapping_add(1);
                            let snap_arc = Arc::new(snap);
                            if let Ok(mut lat) = bg_latest.lock() {
                                *lat = Some(Arc::clone(&snap_arc));
                            }

                            // Evaluate persistent process rules (O(1) lookup, zero cost when empty)
                            let alerts = bg_rules
                                .lock()
                                .map(|mut store| store.evaluate(&snap_arc.processes))
                                .unwrap_or_default();
                            for alert in alerts {
                                let _ = handle.emit("rule-alert", &alert);
                            }

                            // Update system tray tooltip & live 16x16 CPU chart icon every 2 ticks (also while in tray/idle)
                            if loop_tick % 2 == 1 {
                                let tooltip = format!(
                                    "Pulse Taskmanager — CPU {:.0}% | RAM {:.0}% | GPU {:.0}%",
                                    snap_arc.cpu.total_usage,
                                    snap_arc.memory.usage_percent,
                                    snap_arc.gpu.usage_percent.unwrap_or(0.0),
                                );
                                if tooltip != last_tooltip {
                                    if let Some(tray) = handle.tray_by_id("main-tray") {
                                        let _ = tray.set_tooltip(Some(tooltip.as_str()));
                                        last_tooltip = tooltip;
                                    }
                                }

                                tray_cpu_hist.rotate_left(1);
                                tray_cpu_hist[13] =
                                    tray_icon::quantize_cpu_bar(snap_arc.cpu.total_usage);

                                if bg_tray_cpu_icon.load(Ordering::Relaxed) {
                                    let bucket =
                                        tray_icon::cpu_color_bucket(snap_arc.cpu.total_usage);
                                    let state_key = (tray_cpu_hist, bucket);
                                    if last_tray_icon_state != Some(state_key) {
                                        if let Some(tray) = handle.tray_by_id("main-tray") {
                                            let rgba = tray_icon::render_cpu_tray_icon(
                                                &tray_cpu_hist,
                                                snap_arc.cpu.total_usage,
                                            );
                                            let img = tauri::image::Image::new_owned(rgba, 16, 16);
                                            let _ = tray.set_icon(Some(img));
                                            last_tray_icon_state = Some(state_key);
                                        }
                                    }
                                } else {
                                    last_tray_icon_state = None;
                                }
                            }

                            let (ui_vis_now, mini_hud_now) = bg_ui_state
                                .lock()
                                .map(|u| (u.visible, u.mini_hud))
                                .unwrap_or((true, false));
                            let win_hidden_now = handle
                                .get_webview_window("main")
                                .map(|w| {
                                    let vis = w.is_visible().unwrap_or(true);
                                    let min = w.is_minimized().unwrap_or(false);
                                    !vis || min
                                })
                                .unwrap_or(false);
                            let emit_idle = (!ui_vis_now || win_hidden_now) && !mini_hud_now;

                            if !emit_idle {
                                if mini_hud_now {
                                    let hud_snap = TelemetrySnapshot {
                                        timestamp_ms: snap_arc.timestamp_ms,
                                        cpu: snap_arc.cpu.clone(),
                                        memory: snap_arc.memory.clone(),
                                        gpu: snap_arc.gpu.clone(),
                                        disk: snap_arc.disk.clone(),
                                        network: snap_arc.network.clone(),
                                        battery: snap_arc.battery.clone(),
                                        system: snap_arc.system.clone(),
                                        processes: Vec::new(),
                                        latest_point: snap_arc.latest_point.clone(),
                                    };
                                    let _ = handle.emit("telemetry-update", &hud_snap);
                                } else {
                                    let _ = handle.emit("telemetry-update", snap_arc.as_ref());
                                }
                            }
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
            set_ui_state,
            set_telemetry_paused,
            set_minimize_to_tray,
            set_tray_cpu_icon,
            set_mini_hud,
            kill_process,
            kill_process_tree,
            set_process_suspended,
            set_process_priority,
            get_process_priority,
            set_efficiency_mode,
            open_file_location,
            restart_explorer,
            restart_process,
            trim_working_set,
            run_new_task,
            is_elevated,
            restart_as_admin,
            export_report,
            apply_quick_profile,
            get_network_connections,
            check_file_locks,
            get_startup_entries,
            toggle_startup_entry,
            get_autostart_config,
            set_autostart_config,
            get_services,
            control_service,
            set_service_start_type,
            get_process_affinity,
            set_process_affinity,
            pick_window_pid,
            get_process_security_info,
            get_process_modules_and_threads,
            get_process_env_info,
            list_process_rules,
            save_process_rule,
            delete_process_rule,
            close_tcp_connection,
            resolve_reverse_dns,
            get_process_icons,
        ])
        .build(tauri::generate_context!())
        .expect("Fehler beim Starten von Pulse Task Manager")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                net_etw::stop_session_by_name();
            }
        });
}
