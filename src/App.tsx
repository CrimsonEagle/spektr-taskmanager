import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Activity } from "lucide-react";
import { CommandPalette } from "./components/CommandPalette";
import { computeMiniHudHeight, MiniHud } from "./components/MiniHud";
import { ProcessInspector } from "./components/ProcessInspector";
import { RunTaskModal } from "./components/RunTaskModal";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { ToastContainer } from "./components/ToastContainer";
import { useSettings } from "./hooks/useSettings";
import { useTelemetry } from "./hooks/useTelemetry";
import { useTheme } from "./hooks/useTheme";
import { api } from "./lib/tauri";
import {
  ActionResult,
  BlameProcess,
  NavTab,
  PerformanceMetric,
  ProcessEntry,
  ToastMessage,
} from "./types/telemetry";
import { NetworkView } from "./views/NetworkView";
import { OverviewView } from "./views/OverviewView";
import { PerformanceView } from "./views/PerformanceView";
import { ProcessesView } from "./views/ProcessesView";
import { SystemToolsView } from "./views/SystemToolsView";

const EMPTY_PROCESSES: ProcessEntry[] = [];

function isEditableOrControl(
  el: EventTarget | null,
  includeButtons: boolean
): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  ) {
    return true;
  }
  if (includeButtons && (tag === "BUTTON" || tag === "A")) {
    return true;
  }
  return false;
}

function blameToArchivedProcess(bp: BlameProcess): ProcessEntry {
  return {
    pid: bp.pid,
    parentPid: null,
    name: bp.name,
    groupKey: bp.name,
    subtitle: bp.subtitle,
    category: bp.category,
    cpuPercent: bp.cpuPercent,
    gpuPercent: bp.gpuPercent,
    memoryBytes: bp.memoryBytes,
    diskReadBytesPerSec: bp.diskBytesPerSec,
    diskWriteBytesPerSec: 0,
    totalDiskReadBytes: 0,
    totalDiskWriteBytes: 0,
    netRxBytesPerSec: bp.netRxBytesPerSec ?? 0,
    netTxBytesPerSec: bp.netTxBytesPerSec ?? 0,
    status: "Beendet",
    isSuspended: false,
    isEfficiencyMode: false,
    runTimeSeconds: 0,
    exePath: "",
    cmdLine: "",
    handleCount: null,
    threadCount: null,
    cpuHistory: [bp.cpuPercent],
  };
}

export function App() {
  const { preference, setPreference } = useTheme();
  const {
    settings,
    setRefreshMs,
    setMinimizeToTray,
    setTrayCpuIcon,
    toggleTitleBarMetric,
    toggleHudMetric,
  } = useSettings();
  const { snapshot, history, getExitedProcess } = useTelemetry();

  const [activeTab, setActiveTab] = useState<NavTab>("overview");
  const [performanceMetric, setPerformanceMetric] =
    useState<PerformanceMetric>("cpu");
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [selectedFallback, setSelectedFallback] = useState<BlameProcess | null>(
    null
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [runTaskOpen, setRunTaskOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [miniHud, setMiniHud] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [jumpSpikeTs, setJumpSpikeTs] = useState<number | null>(null);
  const [isVisible, setIsVisible] = useState<boolean>(() => !document.hidden);

  const [telemetryPaused, setTelemetryPaused] = useState<boolean>(false);
  const [isElevated, setIsElevated] = useState<boolean | null>(null);
  const [searchFocusNonce, setSearchFocusNonce] = useState<number>(0);
  const [pickingWindow, setPickingWindow] = useState<boolean>(false);
  const [ruleDraftProcessName, setRuleDraftProcessName] = useState<
    string | null
  >(null);

  const toastTimersRef = useRef<Set<number>>(new Set());
  const hudConfigRef = useRef(settings.hudMetrics);
  hudConfigRef.current = settings.hudMetrics;
  const hasBatteryRef = useRef(false);
  hasBatteryRef.current = snapshot?.battery.hasBattery ?? false;

  useEffect(() => {
    return () => {
      for (const timerId of toastTimersRef.current) {
        window.clearTimeout(timerId);
      }
      toastTimersRef.current.clear();
    };
  }, []);

  // Query elevation status once on startup
  useEffect(() => {
    let mounted = true;
    api
      .isElevated()
      .then((elev) => {
        if (mounted) setIsElevated(elev);
      })
      .catch(() => {
        if (mounted) setIsElevated(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  // Sync settings with backend
  useEffect(() => {
    api.setRefreshInterval(settings.refreshMs).catch(() => {});
  }, [settings.refreshMs]);

  useEffect(() => {
    api.setTelemetryPaused(telemetryPaused).catch(() => {});
  }, [telemetryPaused]);

  useEffect(() => {
    api.setMinimizeToTray(settings.minimizeToTray).catch(() => {});
  }, [settings.minimizeToTray]);

  useEffect(() => {
    api.setTrayCpuIcon(settings.trayCpuIcon).catch(() => {});
  }, [settings.trayCpuIcon]);

  // Track window visibility for backend/frontend idle throttling
  useEffect(() => {
    const onVisibility = () => {
      setIsVisible(!document.hidden);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Sync UI state with Rust backend so it can throttle / trim IPC payloads
  useEffect(() => {
    api
      .setUiState({
        visible: isVisible,
        activeTab,
        miniHud,
        paletteOpen,
        inspectedPid: selectedPid,
      })
      .catch(() => {});
  }, [isVisible, activeTab, miniHud, paletteOpen, selectedPid]);

  const pushToast = useCallback(
    (text: string, kind: ToastMessage["kind"] = "info") => {
      const id = `${Date.now()}-${Math.random()}`;
      setToasts((prev) => [...prev.slice(-3), { id, text, kind }]);
      const timerId = window.setTimeout(() => {
        toastTimersRef.current.delete(timerId);
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3600);
      toastTimersRef.current.add(timerId);
    },
    []
  );

  const handleActionFeedback = useCallback(
    (res: ActionResult) => {
      pushToast(res.message, res.ok ? "success" : "error");
    },
    [pushToast]
  );

  const toggleMiniHud = useCallback(async (enable?: boolean) => {
    setMiniHud((prev) => {
      const next = enable ?? !prev;
      if (next) {
        const h = computeMiniHudHeight(
          hudConfigRef.current,
          hasBatteryRef.current
        );
        api.setMiniHud(true, h).catch(() => {
          api.window.enterMiniHud().catch(() => {});
        });
      } else {
        api.setMiniHud(false).catch(() => {
          api.window.exitMiniHud().catch(() => {});
        });
      }
      return next;
    });
  }, []);

  const handleOpenPalette = useCallback(() => setPaletteOpen(true), []);
  const handleClosePalette = useCallback(() => setPaletteOpen(false), []);
  const handleCloseRunTask = useCallback(() => setRunTaskOpen(false), []);
  const handleOpenSettings = useCallback(() => setSettingsOpen(true), []);
  const handleCloseSettings = useCallback(() => setSettingsOpen(false), []);
  const handleOpenSettingsFromHud = useCallback(() => {
    toggleMiniHud(false);
    setSettingsOpen(true);
  }, [toggleMiniHud]);
  const handleEnterMiniHud = useCallback(() => {
    toggleMiniHud(true);
  }, [toggleMiniHud]);
  const handleExitMiniHud = useCallback(() => {
    toggleMiniHud(false);
  }, [toggleMiniHud]);
  const handleSelectPid = useCallback(
    (pid: number, fallback?: BlameProcess) => {
      setSelectedPid(pid);
      setSelectedFallback(fallback ?? null);
    },
    []
  );
  const handleCloseInspector = useCallback(() => {
    setSelectedPid(null);
    setSelectedFallback(null);
  }, []);
  const handleClearInitialSpike = useCallback(() => setJumpSpikeTs(null), []);
  const handleJumpToSpike = useCallback((ts: number) => {
    setJumpSpikeTs(ts);
    setActiveTab("performance");
  }, []);
  const handleOpenPerformanceMetric = useCallback(
    (metric: PerformanceMetric) => {
      setPerformanceMetric(metric);
      setActiveTab("performance");
    },
    []
  );
  const handleTogglePause = useCallback(() => {
    setTelemetryPaused((p) => !p);
  }, []);
  const handleRestartAsAdmin = useCallback(async () => {
    try {
      await api.restartAsAdmin();
    } catch (err) {
      pushToast(`Admin-Neustart fehlgeschlagen: ${String(err)}`, "error");
    }
  }, [pushToast]);

  const handlePickWindow = useCallback(async () => {
    if (pickingWindow) return;
    setPickingWindow(true);
    pushToast("Klicke auf ein Fenster — ESC zum Abbrechen", "info");
    try {
      const pid = await api.pickWindowPid();
      if (pid != null && pid > 0) {
        setSelectedPid(pid);
        setSelectedFallback(null);
        pushToast(`Fenster-Prozess erkannt (PID ${pid}).`, "success");
      }
    } catch (err) {
      pushToast(`Fenster-Auswahl fehlgeschlagen: ${String(err)}`, "error");
    } finally {
      setPickingWindow(false);
    }
  }, [pickingWindow, pushToast]);

  const handleCreateRuleForProcess = useCallback((processName: string) => {
    setRuleDraftProcessName(processName);
    setActiveTab("tools");
  }, []);

  const handleClearRuleDraft = useCallback(() => {
    setRuleDraftProcessName(null);
  }, []);

  // Global keyboard shortcuts: Ctrl+K, Ctrl+F, Ctrl+R, Space (pause), Delete (kill selected)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const keyLower = e.key.toLowerCase();

      if ((e.ctrlKey || e.metaKey) && keyLower === "k") {
        e.preventDefault();
        setRunTaskOpen(false);
        setSettingsOpen(false);
        setPaletteOpen((v) => !v);
        return;
      }

      if ((e.ctrlKey || e.metaKey) && keyLower === "f") {
        e.preventDefault();
        setPaletteOpen(false);
        setRunTaskOpen(false);
        setSettingsOpen(false);
        setActiveTab("processes");
        setSearchFocusNonce((n) => n + 1);
        return;
      }

      if ((e.ctrlKey || e.metaKey) && keyLower === "r") {
        e.preventDefault();
        setPaletteOpen(false);
        setSettingsOpen(false);
        setRunTaskOpen((v) => !v);
        return;
      }

      if (paletteOpen || runTaskOpen || settingsOpen) return;

      if (e.code === "Space" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isEditableOrControl(e.target, true)) return;
        e.preventDefault();
        setTelemetryPaused((p) => !p);
        return;
      }

      if (e.key === "Delete" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (selectedPid == null || isEditableOrControl(e.target, false)) return;
        e.preventDefault();
        api.killProcess(selectedPid).then((res) => {
          handleActionFeedback(res);
          if (res.ok) {
            setSelectedPid(null);
            setSelectedFallback(null);
          }
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [paletteOpen, runTaskOpen, settingsOpen, selectedPid, handleActionFeedback]);

  // Tray icon "Mini-HUD umschalten" event
  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | null = null;
    api
      .subscribeMiniHudToggle(() => toggleMiniHud())
      .then((fn) => {
        if (mounted) unlisten = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      mounted = false;
      if (unlisten) unlisten();
    };
  }, [toggleMiniHud]);

  // Rule alert notifications from backend
  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | null = null;
    api
      .subscribeRuleAlerts((ev) => {
        if (!mounted) return;
        pushToast(
          `${ev.processName} (PID ${ev.pid}): ${ev.message}`,
          "warning"
        );
      })
      .then((fn) => {
        if (mounted) unlisten = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      mounted = false;
      if (unlisten) unlisten();
    };
  }, [pushToast]);

  const handleApplyProfile = useCallback(
    async (profile: "normal" | "eco" | "gaming") => {
      const res = await api.applyQuickProfile(profile);
      handleActionFeedback(res);
    },
    [handleActionFeedback]
  );

  const handleRestartExplorer = useCallback(async () => {
    const res = await api.restartExplorer();
    handleActionFeedback(res);
  }, [handleActionFeedback]);

  const allProcesses = snapshot?.processes ?? EMPTY_PROCESSES;

  const { selectedProcess, selectedIsExited } = useMemo(() => {
    if (selectedPid == null) {
      return { selectedProcess: null, selectedIsExited: false };
    }
    const live = snapshot?.processes.find((p) => p.pid === selectedPid) ?? null;
    if (live) {
      return { selectedProcess: live, selectedIsExited: false };
    }
    const archived = getExitedProcess(selectedPid);
    if (archived) {
      return { selectedProcess: archived, selectedIsExited: true };
    }
    if (selectedFallback && selectedFallback.pid === selectedPid) {
      return {
        selectedProcess: blameToArchivedProcess(selectedFallback),
        selectedIsExited: true,
      };
    }
    return { selectedProcess: null, selectedIsExited: false };
  }, [selectedPid, snapshot, getExitedProcess, selectedFallback]);

  if (miniHud) {
    return (
      <MiniHud
        snapshot={snapshot}
        hudMetrics={settings.hudMetrics}
        onExitMiniHud={handleExitMiniHud}
        onOpenSettings={handleOpenSettingsFromHud}
      />
    );
  }

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden mica-canvas">
      <TitleBar
        snapshot={snapshot}
        telemetryPaused={telemetryPaused}
        isElevated={isElevated}
        pickingWindow={pickingWindow}
        titleBarMetrics={settings.titleBarMetrics}
        onTogglePause={handleTogglePause}
        onRestartAsAdmin={handleRestartAsAdmin}
        onPickWindow={handlePickWindow}
        onOpenSettings={handleOpenSettings}
        onSelectPerformanceMetric={handleOpenPerformanceMetric}
        onOpenPalette={handleOpenPalette}
        onEnterMiniHud={handleEnterMiniHud}
      />

      <div className="flex-1 flex overflow-hidden min-h-0">
        <Sidebar
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          snapshot={snapshot}
          onApplyProfile={handleApplyProfile}
        />

        {/* Main Content Viewport */}
        <main className="flex-1 overflow-y-auto stable-scroll p-5 min-w-0">
          {!snapshot ? (
            <div className="h-full flex flex-col items-center justify-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-sky-500 via-indigo-500 to-violet-500 text-white flex items-center justify-center animate-pulse">
                <Activity className="w-6 h-6" />
              </div>
              <div
                className="text-sm font-medium"
                style={{ color: "var(--text-secondary)" }}
              >
                Sammle Live-Systemdaten…
              </div>
            </div>
          ) : (
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
                className="h-full"
              >
                {activeTab === "overview" && (
                  <OverviewView
                    snapshot={snapshot}
                    history={history}
                    onInspectPid={handleSelectPid}
                    onNavigate={setActiveTab}
                    onOpenPerformanceMetric={handleOpenPerformanceMetric}
                    onJumpToSpike={handleJumpToSpike}
                    onRestartExplorer={handleRestartExplorer}
                  />
                )}

                {activeTab === "processes" && (
                  <ProcessesView
                    processes={snapshot.processes}
                    totalMemoryBytes={snapshot.memory.totalBytes}
                    netPerProcessAvailable={snapshot.network.perProcessAvailable ?? false}
                    selectedPid={selectedPid}
                    searchFocusNonce={searchFocusNonce}
                    pickingWindow={pickingWindow}
                    onPickWindow={handlePickWindow}
                    onSelectPid={handleSelectPid}
                    onRestartAsAdmin={handleRestartAsAdmin}
                    onActionFeedback={handleActionFeedback}
                  />
                )}

                {activeTab === "performance" && (
                  <PerformanceView
                    snapshot={snapshot}
                    history={history}
                    activeMetric={performanceMetric}
                    onMetricChange={setPerformanceMetric}
                    initialSpikeTimestamp={jumpSpikeTs}
                    onClearInitialSpike={handleClearInitialSpike}
                    onInspectPid={handleSelectPid}
                    onRestartAsAdmin={handleRestartAsAdmin}
                    onActionFeedback={handleActionFeedback}
                  />
                )}

                {activeTab === "network" && (
                  <NetworkView
                    snapshot={snapshot}
                    onInspectPid={handleSelectPid}
                    onActionFeedback={handleActionFeedback}
                  />
                )}

                {activeTab === "tools" && (
                  <SystemToolsView
                    onInspectPid={handleSelectPid}
                    onActionFeedback={handleActionFeedback}
                    ruleDraftProcessName={ruleDraftProcessName}
                    onClearRuleDraft={handleClearRuleDraft}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          )}
        </main>

        {/* Slide-In Process Inspector Drawer */}
        <ProcessInspector
          process={selectedProcess}
          isExited={selectedIsExited}
          allProcesses={allProcesses}
          onClose={handleCloseInspector}
          onSelectPid={handleSelectPid}
          onCreateRule={handleCreateRuleForProcess}
          onActionFeedback={handleActionFeedback}
        />
      </div>

      {/* Command Palette (Ctrl+K) — only mounted when open */}
      <AnimatePresence>
        {paletteOpen && (
          <CommandPalette
            onClose={handleClosePalette}
            processes={allProcesses}
            onNavigate={setActiveTab}
            onInspectPid={handleSelectPid}
            onSetTheme={setPreference}
            onEnterMiniHud={handleEnterMiniHud}
            onApplyProfile={handleApplyProfile}
            onActionFeedback={handleActionFeedback}
          />
        )}
      </AnimatePresence>

      {/* Run New Task Modal (Ctrl+R) — only mounted when open */}
      <AnimatePresence>
        {runTaskOpen && (
          <RunTaskModal
            onClose={handleCloseRunTask}
            onActionFeedback={handleActionFeedback}
          />
        )}
      </AnimatePresence>

      {/* Settings Modal — only mounted when open */}
      <AnimatePresence>
        {settingsOpen && (
          <SettingsModal
            settings={settings}
            themePreference={preference}
            onSetTheme={setPreference}
            onSetRefreshMs={setRefreshMs}
            onSetMinimizeToTray={setMinimizeToTray}
            onSetTrayCpuIcon={setTrayCpuIcon}
            onToggleTitleBarMetric={toggleTitleBarMetric}
            onToggleHudMetric={toggleHudMetric}
            onActionFeedback={handleActionFeedback}
            onClose={handleCloseSettings}
          />
        )}
      </AnimatePresence>

      <ToastContainer toasts={toasts} />
    </div>
  );
}

export default App;
