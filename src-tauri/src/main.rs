#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
mod single_instance;
mod startup_services;
mod taskbar_placeholder;
mod telemetry;
mod tray_icon;
mod win_cpu;

use models::{
    ActionResult, AdminPreferenceResult, AutostartConfig, FileLockEntry, HistoryPoint,
    NetworkConnectionEntry, ProcessAffinityInfo, ProcessEnvInfo, ProcessModulesThreads,
    ProcessRule, ProcessSecurityInfo, ServiceEntry, StartupEntry, TelemetrySnapshot,
};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use telemetry::TelemetryEngine;

fn default_refresh_ms() -> u64 {
    1000
}

fn default_true() -> bool {
    true
}

fn default_language() -> String {
    "de".to_string()
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct BackendPrefs {
    #[serde(default = "default_refresh_ms")]
    refresh_ms: u64,
    #[serde(default, alias = "minimize_to_tray")]
    close_to_tray: bool,
    #[serde(default)]
    minimize_to_tray_on_minimize: bool,
    #[serde(default = "default_true")]
    release_webview_on_minimize: bool,
    #[serde(default = "default_true")]
    tray_cpu_icon: bool,
    #[serde(default = "default_language")]
    language: String,
    #[serde(default)]
    always_run_as_admin: bool,
}

impl Default for BackendPrefs {
    fn default() -> Self {
        Self {
            refresh_ms: 1000,
            close_to_tray: false,
            minimize_to_tray_on_minimize: false,
            release_webview_on_minimize: true,
            tray_cpu_icon: true,
            language: "de".to_string(),
            always_run_as_admin: false,
        }
    }
}

fn load_backend_prefs(path: &PathBuf) -> Option<BackendPrefs> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<BackendPrefs>(&raw).ok()
}

fn should_auto_elevate_from_prefs() -> bool {
    const APP_ID: &str = "io.github.crimsoneagle.spektr-taskmanager";
    for env_key in ["APPDATA", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(env_key) {
            let candidate = PathBuf::from(base)
                .join(APP_ID)
                .join("backend_prefs.json");
            if let Some(prefs) = load_backend_prefs(&candidate) {
                return prefs.always_run_as_admin;
            }
        }
    }
    false
}

fn save_backend_prefs(state: &AppState) {
    let Some(path) = state.prefs_path.lock().ok().and_then(|g| g.clone()) else {
        return;
    };
    let prefs = BackendPrefs {
        refresh_ms: state.refresh_ms.lock().map(|g| *g).unwrap_or(1000),
        close_to_tray: state.close_to_tray.load(Ordering::Relaxed),
        minimize_to_tray_on_minimize: state.minimize_to_tray_on_minimize.load(Ordering::Relaxed),
        release_webview_on_minimize: state.release_webview_on_minimize.load(Ordering::Relaxed),
        tray_cpu_icon: state.tray_cpu_icon.load(Ordering::Relaxed),
        language: state
            .language
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| "de".to_string()),
        always_run_as_admin: state.always_run_as_admin.load(Ordering::Relaxed),
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(&prefs) {
        let _ = std::fs::write(path, json);
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiState {
    pub visible: bool,
    pub active_tab: String,
    pub performance_metric: String,
    pub mini_hud: bool,
    pub palette_open: bool,
    pub inspected_pid: Option<u32>,
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            visible: true,
            active_tab: "overview".to_string(),
            performance_metric: "cpu".to_string(),
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
    pub close_to_tray: Arc<AtomicBool>,
    pub minimize_to_tray_on_minimize: Arc<AtomicBool>,
    pub release_webview_on_minimize: Arc<AtomicBool>,
    pub tray_cpu_icon: Arc<AtomicBool>,
    pub always_run_as_admin: Arc<AtomicBool>,
    pub language: Arc<Mutex<String>>,
    pub rule_store: Arc<Mutex<rules::RuleStore>>,
    pub prefs_path: Arc<Mutex<Option<PathBuf>>>,
    pub explicit_exit: Arc<AtomicBool>,
    pub tray_parked: Arc<AtomicBool>,
    pub taskbar_parked: Arc<AtomicBool>,
    pub taskbar_placeholder: Arc<taskbar_placeholder::TaskbarPlaceholder>,
    pub pending_mini_hud: Arc<AtomicBool>,
    pub was_maximized: Arc<AtomicBool>,
    pub last_window_bounds: Arc<Mutex<Option<(f64, f64, f64, f64)>>>,
    pub window_lock: Arc<Mutex<()>>,
    pub single_instance: Arc<single_instance::SingleInstanceGuard>,
}

#[cfg(windows)]
fn apply_low_memory_webview2(win: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
    };
    use windows::core::Interface;

    let _ = win.with_webview(|webview| unsafe {
        if let Ok(core) = webview.controller().CoreWebView2() {
            if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
                let _ = core19
                    .SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW);
            }
        }
    });
}

#[cfg(not(windows))]
fn apply_low_memory_webview2(_win: &tauri::WebviewWindow) {}

#[cfg(windows)]
fn bring_window_to_front(win: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    if let Ok(raw_hwnd) = win.hwnd() {
        let hwnd = HWND(raw_hwnd.0);
        unsafe {
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            let _ = SetForegroundWindow(hwnd);
        }
    }
}

#[cfg(not(windows))]
fn bring_window_to_front(_win: &tauri::WebviewWindow) {}

#[cfg(windows)]
fn raw_webview_hwnd(win: &tauri::WebviewWindow) -> isize {
    win.hwnd().map(|h| h.0 as isize).unwrap_or(0)
}

#[cfg(not(windows))]
fn raw_webview_hwnd(_win: &tauri::WebviewWindow) -> isize {
    0
}

fn capture_main_window_geometry(state: &AppState, win: &tauri::WebviewWindow) {
    let in_mini_hud = state
        .ui_state
        .lock()
        .map(|u| u.mini_hud)
        .unwrap_or(false);
    if in_mini_hud || win.is_minimized().unwrap_or(false) {
        return;
    }
    let is_max = win.is_maximized().unwrap_or(false);
    state.was_maximized.store(is_max, Ordering::Relaxed);
    if !is_max {
        let scale = win.scale_factor().unwrap_or(1.0).max(0.5);
        if let (Ok(pos), Ok(size)) = (win.outer_position(), win.inner_size()) {
            let x = pos.x as f64 / scale;
            let y = pos.y as f64 / scale;
            let w = size.width as f64 / scale;
            let h = size.height as f64 / scale;
            if w >= 900.0 && h >= 580.0 && x > -10_000.0 && y > -10_000.0 {
                if let Ok(mut bounds) = state.last_window_bounds.lock() {
                    *bounds = Some((x, y, w, h));
                }
            }
        }
    }
}

fn open_or_focus_main_window(app: &AppHandle, start_maximized: bool, open_as_mini_hud: bool) {
    let state = app.state::<AppState>();
    let _guard = state
        .window_lock
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    state.tray_parked.store(false, Ordering::SeqCst);
    state.taskbar_parked.store(false, Ordering::SeqCst);

    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        bring_window_to_front(&win);
        if open_as_mini_hud {
            let _ = win.emit("toggle-mini-hud", ());
        }
        state.taskbar_placeholder.close();
        if let Ok(mut ui) = state.ui_state.lock() {
            ui.visible = true;
        }
        trigger_wake(&state.wake_signal);
        return;
    }

    if open_as_mini_hud {
        state.pending_mini_hud.store(true, Ordering::Relaxed);
    } else {
        state.pending_mini_hud.store(false, Ordering::Relaxed);
    }

    let saved_bounds = state.last_window_bounds.lock().ok().and_then(|g| *g);

    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Spektr Taskmanager")
        .decorations(false)
        .transparent(false)
        .shadow(true)
        .visible(false);

    if open_as_mini_hud {
        builder = builder
            .center()
            .inner_size(390.0, 240.0)
            .min_inner_size(340.0, 140.0)
            .always_on_top(true)
            .resizable(false);
    } else {
        builder = builder
            .min_inner_size(960.0, 640.0)
            .resizable(true);
        if let Some((x, y, w, h)) = saved_bounds {
            builder = builder.position(x, y).inner_size(w, h);
        } else {
            builder = builder.center().inner_size(1340.0, 860.0);
        }
    }

    if let Ok(win) = builder.build() {
        apply_low_memory_webview2(&win);
        if !open_as_mini_hud
            && (start_maximized || state.was_maximized.load(Ordering::Relaxed))
        {
            let _ = win.maximize();
        }
        let _ = win.show();
        let _ = win.set_focus();
        bring_window_to_front(&win);
        state.taskbar_placeholder.close();
        if let Ok(mut ui) = state.ui_state.lock() {
            ui.visible = true;
            ui.mini_hud = open_as_mini_hud;
        }
        trigger_wake(&state.wake_signal);
    }
}

fn park_to_tray(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _guard = state
        .window_lock
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    state.tray_parked.store(true, Ordering::SeqCst);
    state.taskbar_parked.store(false, Ordering::SeqCst);
    state.taskbar_placeholder.close();
    if let Some(win) = app.get_webview_window("main") {
        capture_main_window_geometry(&state, &win);
        let _ = win.close();
    }
}

/// Replaces the WebView2 main window with a zero-WebView native Win32 minimized window
/// so the Spektr icon stays in the Windows Taskbar while all `msedgewebview2.exe`
/// processes terminate and free their memory/CPU.
fn park_to_taskbar(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _guard = state
        .window_lock
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    if !state.taskbar_parked.load(Ordering::SeqCst) {
        return;
    }

    state.tray_parked.store(false, Ordering::SeqCst);

    let source_hwnd = if let Some(win) = app.get_webview_window("main") {
        capture_main_window_geometry(&state, &win);
        raw_webview_hwnd(&win)
    } else {
        0
    };

    let restore_app = app.clone();
    let close_app = app.clone();
    let placeholder_ok = state.taskbar_placeholder.show(
        "Spektr Taskmanager",
        source_hwnd,
        move || {
            let app_clone = restore_app.clone();
            std::thread::spawn(move || {
                open_or_focus_main_window(&app_clone, false, false);
            });
        },
        move || {
            let st = close_app.state::<AppState>();
            st.taskbar_parked.store(false, Ordering::SeqCst);
            if st.close_to_tray.load(Ordering::Relaxed) {
                st.tray_parked.store(true, Ordering::SeqCst);
            } else {
                st.explicit_exit.store(true, Ordering::SeqCst);
                close_app.exit(0);
            }
        },
    );

    if !placeholder_ok {
        // Fallback: keep main window minimized normally instead of closing it
        state.taskbar_parked.store(false, Ordering::SeqCst);
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.minimize();
        }
        return;
    }

    if let Some(win) = app.get_webview_window("main") {
        let _ = win.close();
    }

    // Wait briefly for WebView2 window teardown so an immediate restore won't race
    for _ in 0..40 {
        if app.get_webview_window("main").is_none() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

fn trigger_park_to_taskbar(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.taskbar_parked.swap(true, Ordering::SeqCst) {
        return;
    }
    let app_clone = app.clone();
    std::thread::spawn(move || {
        park_to_taskbar(&app_clone);
    });
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
fn get_ui_state(state: State<'_, AppState>) -> UiState {
    state
        .ui_state
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default()
}

#[tauri::command]
fn set_ui_state(
    state: State<'_, AppState>,
    visible: bool,
    active_tab: String,
    performance_metric: Option<String>,
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
        if let Some(metric) = performance_metric {
            guard.performance_metric = metric;
        }
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
    save_backend_prefs(&state);
    trigger_wake(&state.wake_signal);
    let is_en = state
        .language
        .lock()
        .map(|g| g.as_str() == "en")
        .unwrap_or(false);
    ActionResult {
        ok: true,
        message: if is_en {
            format!("Refresh interval set to {} ms.", clamped)
        } else {
            format!("Aktualisierungsrate auf {} ms gesetzt.", clamped)
        },
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

    let is_en = state
        .language
        .lock()
        .map(|g| g.as_str() == "en")
        .unwrap_or(false);

    let label = match (profile.as_str(), is_en) {
        ("eco", true) => format!(
            "Eco profile active ({other_count} throttled) — new background apps are managed automatically."
        ),
        ("eco", false) => format!(
            "Eco-Profil aktiv ({other_count} gedrosselt) — neue Hintergrund-Apps werden automatisch verwaltet."
        ),
        ("gaming", true) => format!(
            "Boost profile active ({boosted} boosted, {other_count} throttled) — new games & 3D apps are prioritized automatically."
        ),
        ("gaming", false) => format!(
            "Boost-Profil aktiv ({boosted} geboostet, {other_count} gedrosselt) — neue Spiele & 3D-Apps werden automatisch priorisiert."
        ),
        (_, true) => format!("Default profile restored ({other_count} processes reset)."),
        (_, false) => format!("Standard-Profil wiederhergestellt ({other_count} Prozesse zurückgesetzt)."),
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
async fn get_autostart_config() -> AutostartConfig {
    tauri::async_runtime::spawn_blocking(startup_services::get_autostart_config)
        .await
        .unwrap_or_else(|_| AutostartConfig {
            enabled: false,
            mode: "minimized".to_string(),
            elevated: false,
        })
}

#[tauri::command]
async fn set_autostart_config(
    enabled: bool,
    mode: String,
    state: State<'_, AppState>,
) -> Result<AutostartConfig, String> {
    let elevated = state.always_run_as_admin.load(Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        startup_services::set_autostart_config(enabled, &mode, elevated)
    })
    .await
    .map_err(|e| format!("Autostart-Task fehlgeschlagen: {e}"))?
}

#[tauri::command]
fn get_always_run_as_admin(state: State<'_, AppState>) -> bool {
    state.always_run_as_admin.load(Ordering::Relaxed)
}

#[tauri::command]
async fn set_always_run_as_admin(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<AdminPreferenceResult, String> {
    let autostart = tauri::async_runtime::spawn_blocking(move || {
        let current = startup_services::get_autostart_config();
        if current.enabled && current.elevated != enabled {
            startup_services::set_autostart_config(true, &current.mode, enabled)
        } else {
            Ok(current)
        }
    })
    .await
    .map_err(|e| format!("Admin-Einstellung fehlgeschlagen: {e}"))??;

    state.always_run_as_admin.store(enabled, Ordering::Relaxed);
    save_backend_prefs(&state);

    Ok(AdminPreferenceResult {
        always_run_as_admin: enabled,
        autostart,
    })
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
fn set_tray_behavior(
    state: State<'_, AppState>,
    close_to_tray: bool,
    minimize_to_tray: bool,
    release_webview_on_minimize: Option<bool>,
) -> Result<(), String> {
    state.close_to_tray.store(close_to_tray, Ordering::Relaxed);
    state
        .minimize_to_tray_on_minimize
        .store(minimize_to_tray, Ordering::Relaxed);
    if let Some(rel) = release_webview_on_minimize {
        state
            .release_webview_on_minimize
            .store(rel, Ordering::Relaxed);
    }
    save_backend_prefs(&state);
    Ok(())
}

#[tauri::command]
fn minimize_window(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let in_mini_hud = state
        .ui_state
        .lock()
        .map(|u| u.mini_hud)
        .unwrap_or(false);
    if !in_mini_hud && state.minimize_to_tray_on_minimize.load(Ordering::Relaxed) {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            park_to_tray(&app_clone);
        });
    } else if !in_mini_hud && state.release_webview_on_minimize.load(Ordering::Relaxed) {
        trigger_park_to_taskbar(&app);
    } else if let Some(win) = app.get_webview_window("main") {
        let _ = win.minimize();
    }
    Ok(())
}

#[tauri::command]
fn set_language(app: AppHandle, state: State<'_, AppState>, lang: String) -> Result<(), String> {
    let normalized = if lang.eq_ignore_ascii_case("en") {
        "en"
    } else {
        "de"
    };
    if let Ok(mut guard) = state.language.lock() {
        *guard = normalized.to_string();
    }
    save_backend_prefs(&state);
    if let Some(tray) = app.tray_by_id("main-tray") {
        if let Ok(menu) = build_tray_menu(&app, normalized) {
            let _ = tray.set_menu(Some(menu));
        }
    }
    Ok(())
}

#[tauri::command]
fn set_tray_cpu_icon(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    state.tray_cpu_icon.store(enabled, Ordering::Relaxed);
    save_backend_prefs(&state);
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
fn take_pending_mini_hud(state: State<'_, AppState>) -> bool {
    state.pending_mini_hud.swap(false, Ordering::Relaxed)
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
fn restart_as_admin(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    process_ops::restart_as_admin()?;
    state.single_instance.release();
    state.explicit_exit.store(true, Ordering::Relaxed);
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

fn build_tray_menu(app: &AppHandle, lang: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let is_en = lang == "en";
    let show_item = MenuItem::with_id(
        app,
        "show",
        if is_en { "Open Spektr" } else { "Spektr öffnen" },
        true,
        None::<&str>,
    )?;
    let hud_item = MenuItem::with_id(
        app,
        "hud",
        if is_en {
            "Toggle Mini-HUD"
        } else {
            "Mini-HUD umschalten"
        },
        true,
        None::<&str>,
    )?;
    let park_item = MenuItem::with_id(
        app,
        "park",
        if is_en {
            "Minimize to Tray (Save RAM)"
        } else {
            "In Tray minimieren (RAM sparen)"
        },
        true,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(
        app,
        "quit",
        if is_en { "Quit" } else { "Beenden" },
        true,
        None::<&str>,
    )?;

    Menu::with_items(app, &[&show_item, &hud_item, &park_item, &quit_item])
}

fn setup_tray(app: &AppHandle, lang: &str) -> tauri::Result<()> {
    let menu = build_tray_menu(app, lang)?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip("Spektr Taskmanager")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                let app_clone = app.clone();
                std::thread::spawn(move || {
                    open_or_focus_main_window(&app_clone, false, false);
                });
            }
            "hud" => {
                let app_clone = app.clone();
                std::thread::spawn(move || {
                    open_or_focus_main_window(&app_clone, false, true);
                });
            }
            "park" => {
                let app_clone = app.clone();
                std::thread::spawn(move || {
                    park_to_tray(&app_clone);
                });
            }
            "quit" => {
                app.state::<AppState>()
                    .explicit_exit
                    .store(true, Ordering::Relaxed);
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
                let app_clone = tray.app_handle().clone();
                std::thread::spawn(move || {
                    open_or_focus_main_window(&app_clone, false, false);
                });
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    let _ = builder.build(app)?;
    Ok(())
}

fn main() {
    // Enforce single instance before starting Tauri/WebView2.
    // If Spektr is already running (even parked in the tray or elevated as Admin),
    // signal it to open/focus its window and exit immediately.
    let cli_args: Vec<String> = std::env::args().collect();
    let is_elevated_handoff = cli_args.iter().any(|a| a == "--elevated-handoff");
    let no_auto_elevate = cli_args.iter().any(|a| a == "--no-auto-elevate");
    let launch_minimized = cli_args
        .iter()
        .any(|a| a == "--start-minimized" || a == "--minimized" || a == "--tray");
    let single_instance = match single_instance::acquire(is_elevated_handoff, launch_minimized) {
        single_instance::AcquireResult::Primary(guard) => Arc::new(guard),
        single_instance::AcquireResult::AlreadyRunning => return,
    };

    // If "Always run as Administrator" is enabled and this launch is non-elevated
    // (e.g. manual start from Start Menu / desktop), seamlessly hand off to an elevated instance
    // before spawning Tauri / WebView2. Elevated autostart via Task Scheduler already starts
    // elevated (`is_elevated() == true`) with zero UAC prompt.
    if !process_ops::is_elevated()
        && !is_elevated_handoff
        && !no_auto_elevate
        && should_auto_elevate_from_prefs()
    {
        let mut forward_args: Vec<String> = cli_args
            .iter()
            .skip(1)
            .filter(|a| *a != "--elevated-handoff" && *a != "--no-auto-elevate")
            .cloned()
            .collect();
        forward_args.push("--elevated-handoff".to_string());
        forward_args.push("--no-auto-elevate".to_string());

        if process_ops::restart_as_admin_with_args(&forward_args).is_ok() {
            single_instance.release();
            return;
        }
    }

    // Keep the main UI thread 100% free of MTA COM/WMI/DXGI calls so Tauri's OleInitialize (STA) succeeds.
    let engine: Arc<Mutex<Option<TelemetryEngine>>> = Arc::new(Mutex::new(None));
    let latest: Arc<Mutex<Option<Arc<TelemetrySnapshot>>>> = Arc::new(Mutex::new(None));
    let refresh_ms = Arc::new(Mutex::new(1000u64));
    let ui_state = Arc::new(Mutex::new(UiState::default()));
    let wake_signal = Arc::new((Mutex::new(0u64), Condvar::new()));
    let paused = Arc::new(AtomicBool::new(false));
    let close_to_tray = Arc::new(AtomicBool::new(false));
    let minimize_to_tray_on_minimize = Arc::new(AtomicBool::new(false));
    let release_webview_on_minimize = Arc::new(AtomicBool::new(true));
    let tray_cpu_icon = Arc::new(AtomicBool::new(true));
    let always_run_as_admin = Arc::new(AtomicBool::new(false));
    let language = Arc::new(Mutex::new("de".to_string()));
    let rule_store = Arc::new(Mutex::new(rules::RuleStore::load(None)));
    let prefs_path: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
    let explicit_exit = Arc::new(AtomicBool::new(false));
    let tray_parked = Arc::new(AtomicBool::new(false));
    let taskbar_parked = Arc::new(AtomicBool::new(false));
    let taskbar_placeholder = Arc::new(taskbar_placeholder::TaskbarPlaceholder::new());
    let pending_mini_hud = Arc::new(AtomicBool::new(false));
    let was_maximized = Arc::new(AtomicBool::new(false));
    let last_window_bounds: Arc<Mutex<Option<(f64, f64, f64, f64)>>> = Arc::new(Mutex::new(None));
    let window_lock = Arc::new(Mutex::new(()));

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
    let setup_prefs_path = Arc::clone(&prefs_path);
    let setup_refresh = Arc::clone(&refresh_ms);
    let setup_close_to_tray = Arc::clone(&close_to_tray);
    let setup_minimize_to_tray_on_minimize = Arc::clone(&minimize_to_tray_on_minimize);
    let setup_release_webview_on_minimize = Arc::clone(&release_webview_on_minimize);
    let setup_tray_cpu_icon = Arc::clone(&tray_cpu_icon);
    let setup_always_run_as_admin = Arc::clone(&always_run_as_admin);
    let setup_language = Arc::clone(&language);
    let setup_single_instance = Arc::clone(&single_instance);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            engine,
            latest,
            refresh_ms,
            ui_state,
            wake_signal,
            paused,
            close_to_tray,
            minimize_to_tray_on_minimize,
            release_webview_on_minimize,
            tray_cpu_icon,
            always_run_as_admin,
            language,
            rule_store,
            prefs_path,
            explicit_exit,
            tray_parked,
            taskbar_parked,
            taskbar_placeholder,
            pending_mini_hud,
            was_maximized,
            last_window_bounds,
            window_lock,
            single_instance,
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                let state = window.state::<AppState>();
                match event {
                    tauri::WindowEvent::Moved(_) => {
                        if let Some(wv) = window.app_handle().get_webview_window("main") {
                            capture_main_window_geometry(&state, &wv);
                        }
                    }
                    tauri::WindowEvent::Resized(_) => {
                        let is_minimized = window.is_minimized().unwrap_or(false);
                        let in_mini_hud = state
                            .ui_state
                            .lock()
                            .map(|u| u.mini_hud)
                            .unwrap_or(false);
                        if is_minimized {
                            if !in_mini_hud {
                                if state.minimize_to_tray_on_minimize.load(Ordering::Relaxed) {
                                    if !state.tray_parked.swap(true, Ordering::SeqCst) {
                                        let app_clone = window.app_handle().clone();
                                        std::thread::spawn(move || {
                                            park_to_tray(&app_clone);
                                        });
                                    }
                                } else if state
                                    .release_webview_on_minimize
                                    .load(Ordering::Relaxed)
                                {
                                    trigger_park_to_taskbar(window.app_handle());
                                }
                            }
                        } else if !in_mini_hud && window.is_visible().unwrap_or(false) {
                            if let Some(wv) = window.app_handle().get_webview_window("main") {
                                capture_main_window_geometry(&state, &wv);
                            }
                        }
                    }
                    tauri::WindowEvent::CloseRequested { .. } => {
                        if let Some(wv) = window.app_handle().get_webview_window("main") {
                            capture_main_window_geometry(&state, &wv);
                        }
                        // Allow the WebviewWindow to actually close so all msedgewebview2.exe
                        // child processes terminate ("Zero-WebView im Tray / in Taskleiste"). Keeping the
                        // background daemon alive is handled in RunEvent::ExitRequested.
                    }
                    tauri::WindowEvent::Destroyed => {
                        if let Ok(mut ui) = state.ui_state.lock() {
                            ui.visible = false;
                            ui.mini_hud = false;
                            ui.palette_open = false;
                            ui.inspected_pid = None;
                        }
                        state.paused.store(false, Ordering::Relaxed);
                        trigger_wake(&state.wake_signal);
                        let _ = process_ops::trim_working_set(std::process::id());
                    }
                    _ => {}
                }
            }
        })
        .setup(move |app| {
            if let Ok(data_dir) = app.path().app_data_dir() {
                let rules_path = data_dir.join("process_rules.json");
                if let Ok(mut guard) = setup_rules.lock() {
                    *guard = rules::RuleStore::load(Some(rules_path));
                }

                let backend_prefs_path = data_dir.join("backend_prefs.json");
                if let Some(prefs) = load_backend_prefs(&backend_prefs_path) {
                    if let Ok(mut r) = setup_refresh.lock() {
                        *r = prefs.refresh_ms.clamp(500, 5000);
                    }
                    setup_close_to_tray.store(prefs.close_to_tray, Ordering::Relaxed);
                    setup_minimize_to_tray_on_minimize
                        .store(prefs.minimize_to_tray_on_minimize, Ordering::Relaxed);
                    setup_release_webview_on_minimize
                        .store(prefs.release_webview_on_minimize, Ordering::Relaxed);
                    setup_tray_cpu_icon.store(prefs.tray_cpu_icon, Ordering::Relaxed);
                    setup_always_run_as_admin.store(prefs.always_run_as_admin, Ordering::Relaxed);
                    if let Ok(mut lang_guard) = setup_language.lock() {
                        *lang_guard = if prefs.language.eq_ignore_ascii_case("en") {
                            "en".to_string()
                        } else {
                            "de".to_string()
                        };
                    }
                }
                if let Ok(mut p) = setup_prefs_path.lock() {
                    *p = Some(backend_prefs_path);
                }
            }

            let initial_lang = setup_language
                .lock()
                .map(|g| g.clone())
                .unwrap_or_else(|_| "de".to_string());
            let _ = setup_tray(app.handle(), &initial_lang);

            let wake_app_handle = app.handle().clone();
            setup_single_instance.start_listener(move || {
                open_or_focus_main_window(&wake_app_handle, false, false);
            });

            // Apply requested startup window mode (normal / maximized / minimized to tray).
            // In minimized-to-tray mode we intentionally skip creating any WebView window so
            // zero msedgewebview2.exe processes spawn until the user opens Spektr from the tray.
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
            } else {
                open_or_focus_main_window(app.handle(), start_maximized, false);
            }

            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("spektr-telemetry".into())
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

                        // Always honor the user-configured refresh interval (including when
                        // minimized or parked in the system tray) so history charts, rules,
                        // and the live CPU tray icon stay continuous and responsive.
                        let delay_ms = bg_refresh.lock().map(|g| *g).unwrap_or(1000);

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

                            // Update system tray tooltip & live 16x16 CPU chart icon at the configured rate
                            let tooltip = format!(
                                "Spektr Taskmanager — CPU {:.0}% | RAM {:.0}% | GPU {:.0}%",
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
                                .unwrap_or(true);
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
            get_ui_state,
            set_ui_state,
            set_telemetry_paused,
            set_tray_behavior,
            minimize_window,
            set_language,
            set_tray_cpu_icon,
            set_mini_hud,
            take_pending_mini_hud,
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
            get_always_run_as_admin,
            set_always_run_as_admin,
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
        .expect("Fehler beim Starten von Spektr Taskmanager")
        .run(|app_handle, event| match event {
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                let state = app_handle.state::<AppState>();
                let is_explicit =
                    code.is_some() || state.explicit_exit.load(Ordering::Relaxed);
                let keep_alive = state.close_to_tray.load(Ordering::Relaxed)
                    || state.tray_parked.load(Ordering::SeqCst)
                    || state.taskbar_parked.load(Ordering::SeqCst);
                if !is_explicit && keep_alive {
                    api.prevent_exit();
                }
            }
            tauri::RunEvent::Exit => {
                let state = app_handle.state::<AppState>();
                state.taskbar_placeholder.close();
                state.single_instance.release();
                net_etw::stop_session_by_name();
            }
            _ => {}
        });
}
