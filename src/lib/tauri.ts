import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ActionResult,
  FileLockEntry,
  HistoryPoint,
  NetworkConnectionEntry,
  ResolvedTheme,
  ServiceEntry,
  StartupEntry,
  TelemetrySnapshot,
} from "../types/telemetry";

export const api = {
  getSnapshot: () => invoke<TelemetrySnapshot | null>("get_snapshot"),
  getHistory: () => invoke<HistoryPoint[]>("get_history"),
  setRefreshInterval: (ms: number) => invoke<ActionResult>("set_refresh_interval", { ms }),

  killProcess: (pid: number) => invoke<ActionResult>("kill_process", { pid }),
  killProcessTree: (pid: number) => invoke<ActionResult>("kill_process_tree", { pid }),
  setProcessSuspended: (pid: number, suspend: boolean) =>
    invoke<ActionResult>("set_process_suspended", { pid, suspend }),
  setProcessPriority: (pid: number, level: string) =>
    invoke<ActionResult>("set_process_priority", { pid, level }),
  setEfficiencyMode: (pid: number, enable: boolean) =>
    invoke<ActionResult>("set_efficiency_mode", { pid, enable }),
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

  getServices: () => invoke<ServiceEntry[]>("get_services"),
  controlService: (name: string, action: "start" | "stop" | "restart") =>
    invoke<ActionResult>("control_service", { name, action }),

  pickFile: async (): Promise<string | null> => {
    const selected = await open({ multiple: false, directory: false });
    if (typeof selected === "string") return selected;
    return null;
  },

  subscribeTelemetry: (cb: (snap: TelemetrySnapshot) => void): Promise<UnlistenFn> =>
    listen<TelemetrySnapshot>("telemetry-update", (e) => cb(e.payload)),

  subscribeMiniHudToggle: (cb: () => void): Promise<UnlistenFn> =>
    listen("toggle-mini-hud", () => cb()),

  window: {
    minimize: () => getCurrentWindow().minimize(),
    toggleMaximize: () => getCurrentWindow().toggleMaximize(),
    close: () => getCurrentWindow().close(),
    startDragging: () => getCurrentWindow().startDragging(),
    isMaximized: () => getCurrentWindow().isMaximized(),
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
