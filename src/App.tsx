import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Activity } from "lucide-react";
import { CommandPalette } from "./components/CommandPalette";
import { MiniHud } from "./components/MiniHud";
import { ProcessInspector } from "./components/ProcessInspector";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { ToastContainer } from "./components/ToastContainer";
import { useTelemetry } from "./hooks/useTelemetry";
import { useTheme } from "./hooks/useTheme";
import { api } from "./lib/tauri";
import {
  ActionResult,
  NavTab,
  ToastMessage,
} from "./types/telemetry";
import { NetworkView } from "./views/NetworkView";
import { OverviewView } from "./views/OverviewView";
import { PerformanceView } from "./views/PerformanceView";
import { ProcessesView } from "./views/ProcessesView";
import { SystemToolsView } from "./views/SystemToolsView";

export function App() {
  const { preference, setPreference, cycleTheme } = useTheme();
  const { snapshot, history } = useTelemetry();

  const [activeTab, setActiveTab] = useState<NavTab>("overview");
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [miniHud, setMiniHud] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [jumpSpikeTs, setJumpSpikeTs] = useState<number | null>(null);

  const pushToast = useCallback(
    (text: string, kind: ToastMessage["kind"] = "info") => {
      const id = `${Date.now()}-${Math.random()}`;
      setToasts((prev) => [...prev.slice(-3), { id, text, kind }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3600);
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
        api.window.enterMiniHud().catch(() => {});
      } else {
        api.window.exitMiniHud().catch(() => {});
      }
      return next;
    });
  }, []);

  // Global keyboard shortcuts (Ctrl+K for Command Palette)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Tray icon "Mini-HUD umschalten" event
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    api
      .subscribeMiniHudToggle(() => toggleMiniHud())
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      if (unlisten) unlisten();
    };
  }, [toggleMiniHud]);

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

  const selectedProcess = useMemo(() => {
    if (selectedPid == null || !snapshot) return null;
    return snapshot.processes.find((p) => p.pid === selectedPid) ?? null;
  }, [selectedPid, snapshot]);

  if (miniHud) {
    return (
      <MiniHud
        snapshot={snapshot}
        onExitMiniHud={() => toggleMiniHud(false)}
      />
    );
  }

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden mica-canvas">
      <TitleBar
        snapshot={snapshot}
        themePreference={preference}
        onCycleTheme={cycleTheme}
        onOpenPalette={() => setPaletteOpen(true)}
        onEnterMiniHud={() => toggleMiniHud(true)}
      />

      <div className="flex-1 flex overflow-hidden min-h-0">
        <Sidebar
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          snapshot={snapshot}
          onApplyProfile={handleApplyProfile}
        />

        {/* Main Content Viewport */}
        <main className="flex-1 overflow-y-auto p-5 min-w-0">
          {!snapshot ? (
            <div className="h-full flex flex-col items-center justify-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-sky-500 via-indigo-500 to-violet-500 text-white flex items-center justify-center animate-pulse">
                <Activity className="w-6 h-6" />
              </div>
              <div className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
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
                    onInspectPid={(pid) => setSelectedPid(pid)}
                    onNavigate={setActiveTab}
                    onJumpToSpike={(ts) => {
                      setJumpSpikeTs(ts);
                      setActiveTab("performance");
                    }}
                    onRestartExplorer={handleRestartExplorer}
                  />
                )}

                {activeTab === "processes" && (
                  <ProcessesView
                    processes={snapshot.processes}
                    totalMemoryBytes={snapshot.memory.totalBytes}
                    selectedPid={selectedPid}
                    onSelectPid={(pid) => setSelectedPid(pid)}
                    onActionFeedback={handleActionFeedback}
                  />
                )}

                {activeTab === "performance" && (
                  <PerformanceView
                    snapshot={snapshot}
                    history={history}
                    initialSpikeTimestamp={jumpSpikeTs}
                    onClearInitialSpike={() => setJumpSpikeTs(null)}
                    onInspectPid={(pid) => setSelectedPid(pid)}
                  />
                )}

                {activeTab === "network" && (
                  <NetworkView
                    snapshot={snapshot}
                    onInspectPid={(pid) => setSelectedPid(pid)}
                    onActionFeedback={handleActionFeedback}
                  />
                )}

                {activeTab === "tools" && (
                  <SystemToolsView
                    onInspectPid={(pid) => setSelectedPid(pid)}
                    onActionFeedback={handleActionFeedback}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          )}
        </main>

        {/* Slide-In Process Inspector Drawer */}
        <ProcessInspector
          process={selectedProcess}
          allProcesses={snapshot?.processes ?? []}
          onClose={() => setSelectedPid(null)}
          onSelectPid={(pid) => setSelectedPid(pid)}
          onActionFeedback={handleActionFeedback}
        />
      </div>

      {/* Command Palette (Ctrl+K) */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        processes={snapshot?.processes ?? []}
        onNavigate={setActiveTab}
        onInspectPid={(pid) => setSelectedPid(pid)}
        onSetTheme={setPreference}
        onEnterMiniHud={() => toggleMiniHud(true)}
        onApplyProfile={handleApplyProfile}
        onActionFeedback={handleActionFeedback}
      />

      <ToastContainer toasts={toasts} />
    </div>
  );
}

export default App;
