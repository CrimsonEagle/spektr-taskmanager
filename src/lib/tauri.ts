import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ActionResult,
  AutostartConfig,
  AutostartMode,
  FileLockEntry,
  HistoryPoint,
  NetworkConnectionEntry,
  ProcessAffinityInfo,
  ProcessEnvInfo,
  ProcessModulesThreads,
  ProcessRule,
  ProcessSecurityInfo,
  ResolvedTheme,
  RuleAlertEvent,
  ServiceEntry,
  StartupEntry,
  TelemetrySnapshot,
} from "../types/telemetry";

export const api = {
  getSnapshot: () => invoke<TelemetrySnapshot | null>("get_snapshot"),
  getHistory: () => invoke<HistoryPoint[]>("get_history"),
  setRefreshInterval: (ms: number) => invoke<ActionResult>("set_refresh_interval", { ms }),
  setTelemetryPaused: (paused: boolean) =>
    invoke<void>("set_telemetry_paused", { paused }),
  setMinimizeToTray: (enabled: boolean) =>
    invoke<void>("set_minimize_to_tray", { enabled }),
  setTrayCpuIcon: (enabled: boolean) =>
    invoke<void>("set_tray_cpu_icon", { enabled }),
  setMiniHud: (enabled: boolean, height?: number) =>
    invoke<void>("set_mini_hud", { enabled, height: height ?? null }),
  setUiState: (payload: {
    visible: boolean;
    activeTab: string;
    miniHud: boolean;
    paletteOpen: boolean;
    inspectedPid: number | null;
  }) => invoke<void>("set_ui_state", payload),

  isElevated: () => invoke<boolean>("is_elevated"),
  restartAsAdmin: () => invoke<void>("restart_as_admin"),

  killProcess: (pid: number) => invoke<ActionResult>("kill_process", { pid }),
  killProcessTree: (pid: number) => invoke<ActionResult>("kill_process_tree", { pid }),
  setProcessSuspended: (pid: number, suspend: boolean) =>
    invoke<ActionResult>("set_process_suspended", { pid, suspend }),
  getProcessPriority: (pid: number) =>
    invoke<string>("get_process_priority", { pid }),
  setProcessPriority: (pid: number, level: string) =>
    invoke<ActionResult>("set_process_priority", { pid, level }),
  getProcessAffinity: (pid: number) =>
    invoke<ProcessAffinityInfo>("get_process_affinity", { pid }),
  setProcessAffinity: (pid: number, mask: number) =>
    invoke<void>("set_process_affinity", { pid, mask }),
  pickWindowPid: () => invoke<number | null>("pick_window_pid"),
  getProcessSecurityInfo: (exePath: string) =>
    invoke<ProcessSecurityInfo>("get_process_security_info", { exePath }),
  getProcessModulesAndThreads: (pid: number) =>
    invoke<ProcessModulesThreads>("get_process_modules_and_threads", { pid }),
  getProcessEnvInfo: (pid: number) =>
    invoke<ProcessEnvInfo>("get_process_env_info", { pid }),
  listProcessRules: () => invoke<ProcessRule[]>("list_process_rules"),
  saveProcessRule: (rule: ProcessRule) =>
    invoke<ProcessRule[]>("save_process_rule", { rule }),
  deleteProcessRule: (id: string) =>
    invoke<ProcessRule[]>("delete_process_rule", { id }),
  closeTcpConnection: (
    localAddr: string,
    localPort: number,
    remoteAddr: string,
    remotePort: number
  ) =>
    invoke<void>("close_tcp_connection", {
      localAddr,
      localPort,
      remoteAddr,
      remotePort,
    }),
  resolveReverseDns: (ip: string) =>
    invoke<string | null>("resolve_reverse_dns", { ip }),
  getProcessIcons: (paths: string[]) =>
    invoke<Record<string, string>>("get_process_icons", { paths }),
  setEfficiencyMode: (pid: number, enable: boolean) =>
    invoke<ActionResult>("set_efficiency_mode", { pid, enable }),
  restartProcess: (pid: number, exePath: string, cmdLine: string) =>
    invoke<number>("restart_process", { pid, exePath, cmdLine }),
  trimWorkingSet: (pid: number) =>
    invoke<number>("trim_working_set", { pid }),
  runNewTask: (command: string) =>
    invoke<void>("run_new_task", { command }),
  exportReport: (path: string, content: string) =>
    invoke<void>("export_report", { path, content }),
  openFileLocation: (exePath: string) =>
    invoke<ActionResult>("open_file_location", { exePath }),
  restartExplorer: () => invoke<ActionResult>("restart_explorer"),
  applyQuickProfile: (profile: string) =>
    invoke<ActionResult>("apply_quick_profile", { profile }),

  getNetworkConnections: () =>
    invoke<NetworkConnectionEntry[]>("get_network_connections"),
  checkFileLocks: (path: string) => invoke<FileLockEntry[]>("check_file_locks", { path }),

  getStartupEntries: () => invoke<StartupEntry[]>("get_startup_entries"),
  toggleStartupEntry: (name: string, registrySubkey: string, enable: boolean) =>
    invoke<ActionResult>("toggle_startup_entry", { name, registrySubkey, enable }),
  getAutostartConfig: () => invoke<AutostartConfig>("get_autostart_config"),
  setAutostartConfig: (enabled: boolean, mode: AutostartMode) =>
    invoke<AutostartConfig>("set_autostart_config", { enabled, mode }),

  getServices: () => invoke<ServiceEntry[]>("get_services"),
  controlService: (name: string, action: "start" | "stop" | "restart") =>
    invoke<ActionResult>("control_service", { name, action }),
  setServiceStartType: (
    name: string,
    startType: "auto" | "manual" | "disabled"
  ) => invoke<void>("set_service_start_type", { name, startType }),

  pickFile: async (): Promise<string | null> => {
    const selected = await open({ multiple: false, directory: false });
    if (typeof selected === "string") return selected;
    return null;
  },
  pickFolder: async (): Promise<string | null> => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") return selected;
    return null;
  },
  saveFile: async (
    defaultPath: string,
    filterName: string,
    extensions: string[]
  ): Promise<string | null> => {
    const selected = await save({
      defaultPath,
      filters: [{ name: filterName, extensions }],
    });
    if (typeof selected === "string") return selected;
    return null;
  },

  subscribeTelemetry: (cb: (snap: TelemetrySnapshot) => void): Promise<UnlistenFn> =>
    listen<TelemetrySnapshot>("telemetry-update", (e) => cb(e.payload)),

  subscribeMiniHudToggle: (cb: () => void): Promise<UnlistenFn> =>
    listen("toggle-mini-hud", () => cb()),

  subscribeRuleAlerts: (cb: (ev: RuleAlertEvent) => void): Promise<UnlistenFn> =>
    listen<RuleAlertEvent>("rule-alert", (e) => cb(e.payload)),

  window: {
    minimize: () => getCurrentWindow().minimize(),
    toggleMaximize: () => getCurrentWindow().toggleMaximize(),
    close: () => getCurrentWindow().close(),
    startDragging: () => getCurrentWindow().startDragging(),
    isMaximized: () => getCurrentWindow().isMaximized(),
    onResized: (cb: () => void): Promise<UnlistenFn> =>
      getCurrentWindow().onResized(() => cb()),
    setTheme: (theme: ResolvedTheme) => getCurrentWindow().setTheme(theme),
    enterMiniHud: async () => {
      const win = getCurrentWindow();
      const max = await win.isMaximized();
      if (max) await win.unmaximize();
      await win.setMinSize(new LogicalSize(340, 175));
      await win.setSize(new LogicalSize(380, 196));
      await win.setAlwaysOnTop(true);
    },
    exitMiniHud: async () => {
      const win = getCurrentWindow();
      await win.setAlwaysOnTop(false);
      await win.setMinSize(new LogicalSize(960, 640));
      await win.setSize(new LogicalSize(1340, 860));
    },
  },
};
