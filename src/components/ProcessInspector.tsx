import React, { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowClockwise as RotateCw,
  ArrowsInSimple as Minimize2,
  ArrowSquareOut as ExternalLink,
  CaretDown as ChevronDown,
  CaretRight as ChevronRight,
  Copy,
  Cpu,
  FolderOpen,
  GitBranch,
  Leaf,
  MagnifyingGlass as Search,
  Pause,
  Play,
  ShareNetwork as Network,
  ShieldCheck,
  ShieldWarning as ShieldAlert,
  Skull,
  SlidersHorizontal,
  Snowflake,
  Stack as Layers,
  Terminal,
  Trash as Trash2,
  X,
} from "@phosphor-icons/react";
import {
  getCachedProcessIcon,
  useProcessIcons,
} from "../hooks/useProcessIcons";
import {
  formatBytes,
  formatDuration,
  formatSpeed,
  getCategoryMeta,
  getProcessMonogram,
} from "../lib/format";
import { api } from "../lib/tauri";
import {
  ActionResult,
  NetworkConnectionEntry,
  ProcessAffinityInfo,
  ProcessEntry,
  ProcessEnvInfo,
  ProcessModulesThreads,
  ProcessSecurityInfo,
} from "../types/telemetry";
import { Sparkline } from "./charts/Sparkline";

interface ProcessInspectorProps {
  process: ProcessEntry | null;
  isExited?: boolean;
  allProcesses: ProcessEntry[];
  onClose: () => void;
  onSelectPid: (pid: number) => void;
  onCreateRule?: (processName: string) => void;
  onActionFeedback: (res: ActionResult) => void;
}

type InspectorTab = "overview" | "security" | "modules" | "env";

function isBitSet(mask: number, bitIndex: number): boolean {
  return (BigInt(mask) & (1n << BigInt(bitIndex))) !== 0n;
}

function toggleBit(mask: number, bitIndex: number): number {
  const next = BigInt(mask) ^ (1n << BigInt(bitIndex));
  return Number(next);
}

export const ProcessInspector: React.FC<ProcessInspectorProps> = React.memo(
  ({
    process,
    isExited = false,
    allProcesses,
    onClose,
    onSelectPid,
    onCreateRule,
    onActionFeedback,
  }) => {
    const [tab, setTab] = useState<InspectorTab>("overview");
    const [ports, setPorts] = useState<NetworkConnectionEntry[]>([]);
    const [priority, setPriority] = useState("normal");
    const [busy, setBusy] = useState(false);

    // On-demand Affinity state
    const [affinityOpen, setAffinityOpen] = useState(false);
    const [affinityInfo, setAffinityInfo] = useState<ProcessAffinityInfo | null>(
      null
    );
    const [affinityMask, setAffinityMask] = useState<number>(0);
    const [affinityLoading, setAffinityLoading] = useState(false);

    // On-demand Security state
    const [securityInfo, setSecurityInfo] =
      useState<ProcessSecurityInfo | null>(null);
    const [securityLoading, setSecurityLoading] = useState(false);
    const [securityError, setSecurityError] = useState<string | null>(null);

    // On-demand Modules & Threads state
    const [modulesInfo, setModulesInfo] =
      useState<ProcessModulesThreads | null>(null);
    const [modulesLoading, setModulesLoading] = useState(false);
    const [modulesError, setModulesError] = useState<string | null>(null);
    const [moduleFilter, setModuleFilter] = useState("");

    // On-demand Environment state
    const [envInfo, setEnvInfo] = useState<ProcessEnvInfo | null>(null);
    const [envLoading, setEnvLoading] = useState(false);
    const [envError, setEnvError] = useState<string | null>(null);
    const [envFilter, setEnvFilter] = useState("");

    const iconPaths = useMemo(
      () => (process?.exePath ? [process.exePath] : []),
      [process?.exePath]
    );
    useProcessIcons(iconPaths);
    const iconUri = process?.exePath
      ? getCachedProcessIcon(process.exePath)
      : null;

    // Reset on PID switch
    useEffect(() => {
      setPriority("normal");
      setAffinityOpen(false);
      setAffinityInfo(null);
      setAffinityMask(0);
      setSecurityInfo(null);
      setSecurityError(null);
      setModulesInfo(null);
      setModulesError(null);
      setModuleFilter("");
      setEnvInfo(null);
      setEnvError(null);
      setEnvFilter("");

      if (!process) {
        setPorts([]);
        setTab("overview");
        return;
      }
      if (isExited) {
        setPorts([]);
        return;
      }
      let active = true;
      api
        .getProcessPriority(process.pid)
        .then((prio) => {
          if (active && prio) setPriority(prio);
        })
        .catch(() => {
          if (active) setPriority("normal");
        });
      api
        .getNetworkConnections()
        .then((list) => {
          if (active) setPorts(list.filter((c) => c.pid === process.pid));
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }, [process?.pid, isExited]);

    // Strictly On-Demand: load CPU Affinity only when expanded
    useEffect(() => {
      if (!process || isExited || !affinityOpen || affinityInfo?.pid === process.pid) return;
      let active = true;
      setAffinityLoading(true);
      api
        .getProcessAffinity(process.pid)
        .then((info) => {
          if (!active) return;
          setAffinityInfo(info);
          setAffinityMask(info.processMask);
        })
        .catch((err) => {
          if (!active) return;
          onActionFeedback({
            ok: false,
            message: `Affinität konnte nicht gelesen werden: ${String(err)}`,
          });
          setAffinityOpen(false);
        })
        .finally(() => {
          if (active) setAffinityLoading(false);
        });
      return () => {
        active = false;
      };
    }, [process?.pid, affinityOpen, affinityInfo?.pid, onActionFeedback]);

    // Strictly On-Demand: load Security info only when "security" tab is selected
    useEffect(() => {
      if (!process || tab !== "security" || securityInfo) return;
      if (!process.exePath) {
        setSecurityError("Kein Dateipfad für diesen Prozess verfügbar.");
        return;
      }
      let active = true;
      setSecurityLoading(true);
      setSecurityError(null);
      api
        .getProcessSecurityInfo(process.exePath)
        .then((info) => {
          if (active) setSecurityInfo(info);
        })
        .catch((err) => {
          if (active) setSecurityError(String(err));
        })
        .finally(() => {
          if (active) setSecurityLoading(false);
        });
      return () => {
        active = false;
      };
    }, [process?.pid, process?.exePath, tab, securityInfo]);

    // Strictly On-Demand: load Modules & Threads only when "modules" tab is selected
    useEffect(() => {
      if (!process || isExited || tab !== "modules" || modulesInfo) return;
      let active = true;
      setModulesLoading(true);
      setModulesError(null);
      api
        .getProcessModulesAndThreads(process.pid)
        .then((info) => {
          if (active) setModulesInfo(info);
        })
        .catch((err) => {
          if (active) setModulesError(String(err));
        })
        .finally(() => {
          if (active) setModulesLoading(false);
        });
      return () => {
        active = false;
      };
    }, [process?.pid, tab, modulesInfo]);

    // Strictly On-Demand: load Environment only when "env" tab is selected
    useEffect(() => {
      if (!process || isExited || tab !== "env" || envInfo) return;
      let active = true;
      setEnvLoading(true);
      setEnvError(null);
      api
        .getProcessEnvInfo(process.pid)
        .then((info) => {
          if (active) setEnvInfo(info);
        })
        .catch((err) => {
          if (active) setEnvError(String(err));
        })
        .finally(() => {
          if (active) setEnvLoading(false);
        });
      return () => {
        active = false;
      };
    }, [process?.pid, tab, envInfo]);

    const parentProc = process?.parentPid
      ? allProcesses.find((p) => p.pid === process.parentPid)
      : undefined;
    const children = process
      ? allProcesses.filter((p) => p.parentPid === process.pid)
      : [];

    const filteredModules = useMemo(() => {
      if (!modulesInfo) return [];
      const q = moduleFilter.trim().toLowerCase();
      if (!q) return modulesInfo.modules;
      return modulesInfo.modules.filter(
        (m) =>
          m.name.toLowerCase().includes(q) || m.path.toLowerCase().includes(q)
      );
    }, [modulesInfo, moduleFilter]);

    const filteredEnvVars = useMemo(() => {
      if (!envInfo) return [];
      const q = envFilter.trim().toLowerCase();
      if (!q) return envInfo.envVars;
      return envInfo.envVars.filter(
        ([k, v]) =>
          k.toLowerCase().includes(q) || v.toLowerCase().includes(q)
      );
    }, [envInfo, envFilter]);

    const runAction = async (
      fn: () => Promise<ActionResult>,
      closeAfter = false
    ) => {
      if (busy) return;
      setBusy(true);
      try {
        const res = await fn();
        onActionFeedback(res);
        if (closeAfter && res.ok) onClose();
      } finally {
        setBusy(false);
      }
    };

    const handleRestartProcess = async () => {
      if (!process || !process.exePath || busy) return;
      setBusy(true);
      try {
        if (isExited) {
          const target = process.cmdLine?.trim() || process.exePath;
          await api.runNewTask(target);
          onActionFeedback({
            ok: true,
            message: `${process.name} erneut gestartet.`,
          });
        } else {
          const newPid = await api.restartProcess(
            process.pid,
            process.exePath,
            process.cmdLine
          );
          onActionFeedback({
            ok: true,
            message: `${process.name} neu gestartet (neue PID ${newPid}).`,
          });
          if (newPid > 0) onSelectPid(newPid);
        }
      } catch (err) {
        onActionFeedback({
          ok: false,
          message: `Neustart fehlgeschlagen: ${String(err)}`,
        });
      } finally {
        setBusy(false);
      }
    };

    const handleTrimWorkingSet = async () => {
      if (!process || busy) return;
      setBusy(true);
      try {
        const freedBytes = await api.trimWorkingSet(process.pid);
        onActionFeedback({
          ok: true,
          message:
            freedBytes > 0
              ? `RAM von ${process.name} getrimmt (${formatBytes(freedBytes)} freigegeben).`
              : `RAM von ${process.name} getrimmt.`,
        });
      } catch (err) {
        onActionFeedback({
          ok: false,
          message: `RAM-Trimmen fehlgeschlagen: ${String(err)}`,
        });
      } finally {
        setBusy(false);
      }
    };

    const handleApplyAffinity = async () => {
      if (!process || !affinityInfo || affinityMask === 0 || busy) return;
      setBusy(true);
      try {
        await api.setProcessAffinity(process.pid, affinityMask);
        setAffinityInfo({ ...affinityInfo, processMask: affinityMask });
        onActionFeedback({
          ok: true,
          message: `CPU-Affinität für ${process.name} aktualisiert.`,
        });
      } catch (err) {
        onActionFeedback({
          ok: false,
          message: `Affinität konnte nicht gesetzt werden: ${String(err)}`,
        });
      } finally {
        setBusy(false);
      }
    };

    const selectAffinityPreset = (preset: "all" | "p" | "e") => {
      if (!affinityInfo) return;
      if (preset === "all") {
        setAffinityMask(affinityInfo.systemMask);
        return;
      }
      let mask = 0n;
      for (const c of affinityInfo.cores) {
        if ((preset === "p" && c.isPCore) || (preset === "e" && !c.isPCore)) {
          mask |= 1n << BigInt(c.index);
        }
      }
      const clamped = mask & BigInt(affinityInfo.systemMask);
      if (clamped !== 0n) setAffinityMask(Number(clamped));
    };

    const copyText = (text: string, label: string) => {
      navigator.clipboard.writeText(text).then(() => {
        onActionFeedback({
          ok: true,
          message: `${label} in Zwischenablage kopiert.`,
        });
      });
    };

    const cat = process ? getCategoryMeta(process.category) : null;
    const cpuAvg30s = useMemo(() => {
      if (!process || process.cpuHistory.length === 0) {
        return process?.cpuPercent ?? 0;
      }
      let sum = 0;
      for (let i = 0; i < process.cpuHistory.length; i++) {
        sum += process.cpuHistory[i];
      }
      return sum / process.cpuHistory.length;
    }, [process]);

    return (
      <AnimatePresence>
        {process && cat && (
          <motion.aside
            key="inspector"
            initial={{ x: 420, opacity: 0.4 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 420, opacity: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 34 }}
            className="w-[410px] shrink-0 h-full border-l flex flex-col overflow-hidden z-20"
            style={{
              backgroundColor: "var(--bg-drawer)",
              borderColor: "var(--border-strong)",
              boxShadow: "var(--shadow-float)",
            }}
          >
            {/* Header */}
            <div
              className="p-4 border-b flex items-start justify-between gap-3"
              style={{ borderColor: "var(--border-subtle)" }}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center font-bold text-xs shrink-0 overflow-hidden"
                  style={{
                    backgroundColor: iconUri ? "var(--bg-subtle)" : cat.softBg,
                    color: cat.color,
                    border: `1px solid ${cat.color}33`,
                  }}
                >
                  {iconUri ? (
                    <img
                      src={iconUri}
                      alt=""
                      className="w-5 h-5 object-contain"
                      draggable={false}
                    />
                  ) : (
                    getProcessMonogram(process.name)
                  )}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-sm truncate">
                      {process.name}
                    </h3>
                    <span
                      className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md shrink-0"
                      style={{ backgroundColor: cat.softBg, color: cat.color }}
                    >
                      {cat.label}
                    </span>
                  </div>
                  <div
                    className="text-xs truncate mt-0.5 flex items-center gap-2 tabular-nums"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    <span>PID {process.pid}</span>
                    {process.subtitle && (
                      <>
                        <span>•</span>
                        <span className="truncate">{process.subtitle}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
              <button
                onClick={onClose}
                className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer hover:bg-[var(--bg-surface-hover)] shrink-0"
                style={{ color: "var(--text-secondary)" }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Inspector Tab Bar */}
            <div
              className="grid grid-cols-4 gap-1 px-3 py-2 border-b text-[11px] font-semibold shrink-0"
              style={{
                borderColor: "var(--border-subtle)",
                backgroundColor: "var(--bg-subtle)",
              }}
            >
              {(
                [
                  { id: "overview", label: "Übersicht" },
                  { id: "security", label: "Sicherheit" },
                  { id: "modules", label: "Module" },
                  { id: "env", label: "Umgebung" },
                ] as const
              ).map((t) => {
                const active = tab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className="py-1.5 px-1.5 rounded-lg cursor-pointer transition-colors truncate"
                    style={{
                      backgroundColor: active
                        ? "var(--bg-surface-solid)"
                        : "transparent",
                      color: active
                        ? "var(--accent-cpu)"
                        : "var(--text-secondary)",
                    }}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>

            {/* Scrollable Tab Content */}
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
              {/* TAB 1: OVERVIEW */}
              {tab === "overview" && (
                <>
                  {/* Live Badges */}
                  {(isExited || process.isSuspended || process.isEfficiencyMode) && (
                    <div className="flex flex-wrap gap-1.5">
                      {isExited && (
                        <span
                          className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg font-semibold"
                          style={{
                            backgroundColor: "var(--accent-disk-soft)",
                            color: "var(--accent-disk)",
                          }}
                        >
                          Beendet (Archiv) — letzte bekannte Daten
                        </span>
                      )}
                      {process.isSuspended && !isExited && (
                        <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-sky-500/15 text-sky-500 font-medium">
                          <Snowflake className="w-3.5 h-3.5" />
                          Prozess eingefroren
                        </span>
                      )}
                      {process.isEfficiencyMode && !isExited && (
                        <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-emerald-500/15 text-emerald-500 font-medium">
                          <Leaf className="w-3.5 h-3.5" />
                          Eco-Modus aktiv
                        </span>
                      )}
                    </div>
                  )}

                  {/* Live Metrics Row */}
                  <div className="grid grid-cols-2 gap-2.5">
                    <div
                      className="p-3 rounded-xl border"
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        borderColor: "var(--border-subtle)",
                      }}
                    >
                      <div
                        className="text-[11px] font-medium mb-1 flex items-center justify-between gap-1"
                        style={{ color: "var(--text-muted)" }}
                      >
                        <span>{isExited ? "Letzte CPU-Last" : "CPU-Last (Live)"}</span>
                        <span className="tabular-nums text-[10px]">
                          Ø 30s: {cpuAvg30s.toFixed(1)}%
                        </span>
                      </div>
                      <div className="flex items-end justify-between gap-2">
                        <span
                          className="text-lg font-bold tabular-nums"
                          style={{ color: "var(--accent-cpu)" }}
                        >
                          {process.cpuPercent.toFixed(1)}%
                        </span>
                        <Sparkline
                          data={process.cpuHistory}
                          color="var(--accent-cpu)"
                          width={78}
                          height={26}
                          showEndDot
                        />
                      </div>
                    </div>

                    <div
                      className="p-3 rounded-xl border"
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        borderColor: "var(--border-subtle)",
                      }}
                    >
                      <div
                        className="text-[11px] font-medium mb-1"
                        style={{ color: "var(--text-muted)" }}
                      >
                        Arbeitsspeicher
                      </div>
                      <div
                        className="text-lg font-bold tabular-nums"
                        style={{ color: "var(--accent-ram)" }}
                      >
                        {formatBytes(process.memoryBytes)}
                      </div>
                      <div
                        className="text-[11px] tabular-nums mt-0.5"
                        style={{ color: "var(--text-muted)" }}
                      >
                        Laufzeit: {formatDuration(process.runTimeSeconds)}
                      </div>
                    </div>
                  </div>

                  {/* Action Controls */}
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span
                        className="text-[11px] font-semibold uppercase tracking-wider"
                        style={{ color: "var(--text-muted)" }}
                      >
                        Aktionen
                      </span>
                      {onCreateRule && (
                        <button
                          onClick={() => onCreateRule(process.name)}
                          className="text-[11px] font-semibold flex items-center gap-1 hover:underline cursor-pointer"
                          style={{ color: "var(--accent-cpu)" }}
                          title="Dauerhafte Regel für diesen Prozessnamen anlegen"
                        >
                          <SlidersHorizontal className="w-3 h-3" />
                          Regel erstellen
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        disabled={busy || isExited}
                        onClick={() =>
                          runAction(() => api.killProcess(process.pid), true)
                        }
                        className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-colors cursor-pointer disabled:opacity-40"
                        style={{
                          backgroundColor: "var(--accent-danger-soft)",
                          color: "var(--accent-danger)",
                        }}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Beenden
                      </button>
                      <button
                        disabled={busy || isExited}
                        onClick={() =>
                          runAction(
                            () => api.killProcessTree(process.pid),
                            true
                          )
                        }
                        className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-colors cursor-pointer border disabled:opacity-40"
                        style={{
                          backgroundColor: "var(--bg-subtle)",
                          borderColor: "var(--border-subtle)",
                          color: "var(--accent-danger)",
                        }}
                      >
                        <Skull className="w-3.5 h-3.5" />
                        Prozessbaum
                      </button>

                      <button
                        disabled={busy || isExited}
                        onClick={() =>
                          runAction(() =>
                            api.setProcessSuspended(
                              process.pid,
                              !process.isSuspended
                            )
                          )
                        }
                        className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-colors cursor-pointer border disabled:opacity-40"
                        style={{
                          backgroundColor: process.isSuspended
                            ? "var(--accent-cpu-soft)"
                            : "var(--bg-subtle)",
                          borderColor: "var(--border-subtle)",
                          color: process.isSuspended
                            ? "var(--accent-cpu)"
                            : "var(--text-primary)",
                        }}
                      >
                        {process.isSuspended ? (
                          <>
                            <Play className="w-3.5 h-3.5" />
                            Fortsetzen
                          </>
                        ) : (
                          <>
                            <Pause className="w-3.5 h-3.5" />
                            Einfrieren
                          </>
                        )}
                      </button>

                      <button
                        disabled={busy || isExited}
                        onClick={() =>
                          runAction(() =>
                            api.setEfficiencyMode(
                              process.pid,
                              !process.isEfficiencyMode
                            )
                          )
                        }
                        className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-colors cursor-pointer border disabled:opacity-40"
                        style={{
                          backgroundColor: process.isEfficiencyMode
                            ? "var(--accent-gpu-soft)"
                            : "var(--bg-subtle)",
                          borderColor: "var(--border-subtle)",
                          color: process.isEfficiencyMode
                            ? "var(--accent-gpu)"
                            : "var(--text-primary)",
                        }}
                      >
                        <Leaf className="w-3.5 h-3.5" />
                        {process.isEfficiencyMode ? "Eco aus" : "Eco-Modus"}
                      </button>

                      <button
                        disabled={busy || !process.exePath}
                        onClick={handleRestartProcess}
                        className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-colors cursor-pointer border disabled:opacity-40 hover:bg-[var(--bg-surface-hover)]"
                        style={{
                          backgroundColor: "var(--bg-subtle)",
                          borderColor: "var(--border-subtle)",
                          color: "var(--text-primary)",
                        }}
                        title={
                          isExited
                            ? "Prozess erneut starten"
                            : "Prozess beenden und mit gleicher Kommandozeile neu starten"
                        }
                      >
                        <RotateCw className="w-3.5 h-3.5" />
                        {isExited ? "Erneut starten" : "Neu starten"}
                      </button>

                      <button
                        disabled={busy || isExited}
                        onClick={handleTrimWorkingSet}
                        className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-colors cursor-pointer border disabled:opacity-40 hover:bg-[var(--bg-surface-hover)]"
                        style={{
                          backgroundColor: "var(--bg-subtle)",
                          borderColor: "var(--border-subtle)",
                          color: "var(--accent-ram)",
                        }}
                        title="Ungenutzten Arbeitsspeicher (Working Set) freigeben"
                      >
                        <Minimize2 className="w-3.5 h-3.5" />
                        RAM trimmen
                      </button>
                    </div>

                    {/* Priority & Open Folder */}
                    <div className="flex items-center gap-2 mt-1">
                      <select
                        disabled={isExited}
                        value={priority}
                        onChange={(e) => {
                          const val = e.target.value;
                          setPriority(val);
                          runAction(() =>
                            api.setProcessPriority(process.pid, val)
                          );
                        }}
                        className="flex-1 px-2.5 py-2 rounded-xl text-xs font-medium border outline-none cursor-pointer disabled:opacity-40"
                        style={{
                          backgroundColor: "var(--bg-surface-solid)",
                          borderColor: "var(--border-subtle)",
                          color: "var(--text-primary)",
                        }}
                      >
                        <option value="idle">Priorität: Niedrig (Idle)</option>
                        <option value="below_normal">
                          Priorität: Niedriger als Normal
                        </option>
                        <option value="normal">Priorität: Normal</option>
                        <option value="above_normal">
                          Priorität: Höher als Normal
                        </option>
                        <option value="high">Priorität: Hoch</option>
                        {priority === "realtime" && (
                          <option value="realtime" disabled>
                            Priorität: Echtzeit
                          </option>
                        )}
                      </select>

                      <button
                        onClick={() =>
                          runAction(() => api.openFileLocation(process.exePath))
                        }
                        disabled={!process.exePath}
                        className="px-3 py-2 rounded-xl text-xs font-medium border flex items-center gap-1.5 cursor-pointer disabled:opacity-40 hover:bg-[var(--bg-surface-hover)]"
                        style={{
                          backgroundColor: "var(--bg-subtle)",
                          borderColor: "var(--border-subtle)",
                        }}
                        title="Speicherort im Windows Explorer öffnen"
                      >
                        <FolderOpen className="w-3.5 h-3.5" />
                        Ordner
                      </button>
                    </div>
                  </div>

                  {/* On-Demand Collapsible CPU Affinity & P-/E-Core Pinning */}
                  {!isExited && (
                    <div
                      className="rounded-xl border overflow-hidden"
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        borderColor: "var(--border-subtle)",
                      }}
                    >
                    <button
                      onClick={() => setAffinityOpen((v) => !v)}
                      className="w-full px-3 py-2.5 flex items-center justify-between text-xs font-semibold cursor-pointer hover:bg-[var(--bg-surface-hover)]"
                    >
                      <span className="flex items-center gap-1.5">
                        <Cpu
                          className="w-3.5 h-3.5"
                          style={{ color: "var(--accent-cpu)" }}
                        />
                        <span>CPU-Affinität & Kerne</span>
                      </span>
                      {affinityOpen ? (
                        <ChevronDown className="w-3.5 h-3.5 opacity-70" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5 opacity-70" />
                      )}
                    </button>

                    {affinityOpen && (
                      <div
                        className="p-3 border-t flex flex-col gap-2.5"
                        style={{ borderColor: "var(--border-subtle)" }}
                      >
                        {affinityLoading ? (
                          <div
                            className="text-[11px] text-center py-2"
                            style={{ color: "var(--text-muted)" }}
                          >
                            Lade CPU-Topologie…
                          </div>
                        ) : affinityInfo ? (
                          <>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <button
                                onClick={() => selectAffinityPreset("all")}
                                className="px-2 py-1 rounded-md text-[10px] font-semibold border cursor-pointer hover:bg-[var(--bg-surface-hover)]"
                                style={{
                                  backgroundColor: "var(--bg-surface-solid)",
                                  borderColor: "var(--border-subtle)",
                                }}
                              >
                                Alle
                              </button>
                              {affinityInfo.hasHybridCores && (
                                <>
                                  <button
                                    onClick={() => selectAffinityPreset("p")}
                                    className="px-2 py-1 rounded-md text-[10px] font-semibold border cursor-pointer"
                                    style={{
                                      backgroundColor: "var(--accent-cpu-soft)",
                                      borderColor: "var(--accent-cpu)",
                                      color: "var(--accent-cpu)",
                                    }}
                                  >
                                    Nur P-Cores
                                  </button>
                                  <button
                                    onClick={() => selectAffinityPreset("e")}
                                    className="px-2 py-1 rounded-md text-[10px] font-semibold border cursor-pointer"
                                    style={{
                                      backgroundColor: "var(--accent-gpu-soft)",
                                      borderColor: "var(--accent-gpu)",
                                      color: "var(--accent-gpu)",
                                    }}
                                  >
                                    Nur E-Cores
                                  </button>
                                </>
                              )}
                            </div>

                            <div className="grid grid-cols-4 gap-1">
                              {affinityInfo.cores.map((core) => {
                                const allowed = isBitSet(
                                  affinityInfo.systemMask,
                                  core.index
                                );
                                const checked = isBitSet(
                                  affinityMask,
                                  core.index
                                );
                                return (
                                  <button
                                    key={core.index}
                                    disabled={!allowed}
                                    onClick={() =>
                                      setAffinityMask((m) =>
                                        toggleBit(m, core.index)
                                      )
                                    }
                                    className="px-1.5 py-1 rounded-lg text-[10px] font-semibold tabular-nums border flex items-center justify-between cursor-pointer disabled:opacity-35"
                                    style={{
                                      backgroundColor: checked
                                        ? "var(--accent-cpu-soft)"
                                        : "var(--bg-surface-solid)",
                                      borderColor: checked
                                        ? "var(--accent-cpu)"
                                        : "var(--border-subtle)",
                                      color: checked
                                        ? "var(--accent-cpu)"
                                        : "var(--text-secondary)",
                                    }}
                                  >
                                    <span>#{core.index}</span>
                                    {affinityInfo.hasHybridCores && (
                                      <span
                                        className="text-[9px] px-1 rounded"
                                        style={{
                                          backgroundColor: core.isPCore
                                            ? "rgba(2,132,199,0.16)"
                                            : "rgba(16,185,129,0.16)",
                                          color: core.isPCore
                                            ? "var(--accent-cpu)"
                                            : "var(--accent-gpu)",
                                        }}
                                      >
                                        {core.isPCore ? "P" : "E"}
                                      </span>
                                    )}
                                  </button>
                                );
                              })}
                            </div>

                            <button
                              disabled={busy || affinityMask === 0}
                              onClick={handleApplyAffinity}
                              className="w-full py-1.5 rounded-lg text-xs font-semibold text-white cursor-pointer disabled:opacity-40"
                              style={{ backgroundColor: "var(--accent-cpu)" }}
                            >
                              Affinität anwenden
                            </button>
                          </>
                        ) : null}
                      </div>
                    )}
                    </div>
                  )}

                  {/* I/O & System Stats */}
                  <div
                    className="p-3 rounded-xl border flex flex-col gap-2 text-xs"
                    style={{
                      backgroundColor: "var(--bg-subtle)",
                      borderColor: "var(--border-subtle)",
                    }}
                  >
                    <div className="flex justify-between">
                      <span style={{ color: "var(--text-muted)" }}>
                        Datenträger Lesen / Schreiben
                      </span>
                      <span className="font-medium tabular-nums">
                        {formatSpeed(process.diskReadBytesPerSec)} /{" "}
                        {formatSpeed(process.diskWriteBytesPerSec)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span style={{ color: "var(--text-muted)" }}>
                        Netzwerk ↓ / ↑
                      </span>
                      <span
                        className="font-medium tabular-nums"
                        style={{
                          color:
                            process.netRxBytesPerSec + process.netTxBytesPerSec >= 100
                              ? "var(--accent-net)"
                              : undefined,
                        }}
                      >
                        {process.netRxBytesPerSec + process.netTxBytesPerSec >= 100
                          ? `${formatSpeed(process.netRxBytesPerSec)} / ${formatSpeed(process.netTxBytesPerSec)}`
                          : "–"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span style={{ color: "var(--text-muted)" }}>
                        Gesamt-I/O (R / W)
                      </span>
                      <span className="font-medium tabular-nums">
                        {formatBytes(process.totalDiskReadBytes)} /{" "}
                        {formatBytes(process.totalDiskWriteBytes)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span style={{ color: "var(--text-muted)" }}>
                        Threads / Offene Handles
                      </span>
                      <span className="font-medium tabular-nums">
                        {process.threadCount ?? "–"} /{" "}
                        {process.handleCount ?? "–"}
                      </span>
                    </div>
                    {parentProc && (
                      <div className="flex justify-between items-center">
                        <span style={{ color: "var(--text-muted)" }}>
                          Elternprozess
                        </span>
                        <button
                          onClick={() => onSelectPid(parentProc.pid)}
                          className="font-medium hover:underline cursor-pointer"
                          style={{ color: "var(--accent-cpu)" }}
                        >
                          {parentProc.name} ({parentProc.pid})
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Executable Path & Command Line */}
                  {process.exePath && (
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between">
                        <span
                          className="text-[11px] font-semibold uppercase tracking-wider"
                          style={{ color: "var(--text-muted)" }}
                        >
                          Dateipfad
                        </span>
                        <button
                          onClick={() => copyText(process.exePath, "Dateipfad")}
                          className="text-[11px] flex items-center gap-1 hover:underline cursor-pointer"
                          style={{ color: "var(--accent-cpu)" }}
                        >
                          <Copy className="w-3 h-3" /> Kopieren
                        </button>
                      </div>
                      <div
                        className="p-2.5 rounded-xl text-[11px] font-mono break-all border select-text"
                        style={{
                          backgroundColor: "var(--bg-subtle)",
                          borderColor: "var(--border-subtle)",
                          color: "var(--text-secondary)",
                        }}
                      >
                        {process.exePath}
                      </div>
                    </div>
                  )}

                  {process.cmdLine && (
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between">
                        <span
                          className="text-[11px] font-semibold uppercase tracking-wider flex items-center gap-1"
                          style={{ color: "var(--text-muted)" }}
                        >
                          <Terminal className="w-3 h-3" /> Kommandozeile
                        </span>
                        <button
                          onClick={() =>
                            copyText(process.cmdLine, "Kommandozeile")
                          }
                          className="text-[11px] flex items-center gap-1 hover:underline cursor-pointer"
                          style={{ color: "var(--accent-cpu)" }}
                        >
                          <Copy className="w-3 h-3" /> Kopieren
                        </button>
                      </div>
                      <div
                        className="p-2.5 rounded-xl text-[11px] font-mono break-all max-h-28 overflow-y-auto border select-text"
                        style={{
                          backgroundColor: "var(--bg-subtle)",
                          borderColor: "var(--border-subtle)",
                          color: "var(--text-secondary)",
                        }}
                      >
                        {process.cmdLine}
                      </div>
                    </div>
                  )}

                  {/* Open Ports for this PID */}
                  {ports.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      <span
                        className="text-[11px] font-semibold uppercase tracking-wider flex items-center gap-1.5"
                        style={{ color: "var(--text-muted)" }}
                      >
                        <Network className="w-3 h-3" /> Netzwerk & Ports (
                        {ports.length})
                      </span>
                      <div className="flex flex-col gap-1">
                        {ports.slice(0, 8).map((c, idx) => (
                          <div
                            key={`${c.protocol}-${c.localPort}-${idx}`}
                            className="px-2.5 py-1.5 rounded-lg border text-[11px] flex items-center justify-between tabular-nums"
                            style={{
                              backgroundColor: "var(--bg-subtle)",
                              borderColor: "var(--border-subtle)",
                            }}
                          >
                            <span className="font-mono font-semibold">
                              {c.protocol} :{c.localPort}
                            </span>
                            <span
                              className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                              style={{
                                backgroundColor:
                                  c.state === "LISTENING"
                                    ? "var(--accent-gpu-soft)"
                                    : "var(--accent-net-soft)",
                                color:
                                  c.state === "LISTENING"
                                    ? "var(--accent-gpu)"
                                    : "var(--accent-net)",
                              }}
                            >
                              {c.state}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Child Processes */}
                  {children.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      <span
                        className="text-[11px] font-semibold uppercase tracking-wider flex items-center gap-1.5"
                        style={{ color: "var(--text-muted)" }}
                      >
                        <GitBranch className="w-3 h-3" /> Kindprozesse (
                        {children.length})
                      </span>
                      <div className="flex flex-col gap-1">
                        {children.slice(0, 10).map((ch) => (
                          <button
                            key={ch.pid}
                            onClick={() => onSelectPid(ch.pid)}
                            className="px-2.5 py-1.5 rounded-lg border text-xs flex items-center justify-between hover:bg-[var(--bg-surface-hover)] cursor-pointer text-left"
                            style={{
                              backgroundColor: "var(--bg-subtle)",
                              borderColor: "var(--border-subtle)",
                            }}
                          >
                            <span className="truncate font-medium">
                              {ch.name}{" "}
                              <span
                                className="text-[11px]"
                                style={{ color: "var(--text-muted)" }}
                              >
                                ({ch.pid})
                              </span>
                            </span>
                            <span className="text-[11px] tabular-nums shrink-0 ml-2">
                              {formatBytes(ch.memoryBytes)}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* TAB 2: SECURITY (On-Demand) */}
              {tab === "security" && (
                <div className="flex flex-col gap-3">
                  {securityLoading ? (
                    <div
                      className="p-6 text-center text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Prüfe digitale Signatur & SHA-256…
                    </div>
                  ) : securityError ? (
                    <div
                      className="p-3 rounded-xl border text-xs"
                      style={{
                        backgroundColor: "var(--accent-danger-soft)",
                        borderColor: "var(--accent-danger)",
                        color: "var(--accent-danger)",
                      }}
                    >
                      {securityError}
                    </div>
                  ) : securityInfo ? (
                    <>
                      <div
                        className="p-3 rounded-xl border flex items-center gap-2.5 text-xs font-semibold"
                        style={{
                          backgroundColor: securityInfo.signed
                            ? "var(--accent-gpu-soft)"
                            : "var(--accent-disk-soft)",
                          borderColor: securityInfo.signed
                            ? "var(--accent-gpu)"
                            : "var(--accent-disk)",
                          color: securityInfo.signed
                            ? "var(--accent-gpu)"
                            : "var(--accent-disk)",
                        }}
                      >
                        {securityInfo.signed ? (
                          <ShieldCheck className="w-4 h-4 shrink-0" />
                        ) : (
                          <ShieldAlert className="w-4 h-4 shrink-0" />
                        )}
                        <span>{securityInfo.signatureStatus}</span>
                      </div>

                      <div
                        className="p-3 rounded-xl border flex flex-col gap-2 text-xs"
                        style={{
                          backgroundColor: "var(--bg-subtle)",
                          borderColor: "var(--border-subtle)",
                        }}
                      >
                        <div className="flex justify-between gap-2">
                          <span style={{ color: "var(--text-muted)" }}>
                            Herausgeber
                          </span>
                          <span className="font-medium text-right truncate">
                            {securityInfo.companyName || "Unbekannt"}
                          </span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span style={{ color: "var(--text-muted)" }}>
                            Beschreibung
                          </span>
                          <span className="font-medium text-right truncate">
                            {securityInfo.fileDescription || "–"}
                          </span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span style={{ color: "var(--text-muted)" }}>
                            Dateiversion
                          </span>
                          <span className="font-mono text-[11px]">
                            {securityInfo.fileVersion || "–"}
                          </span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span style={{ color: "var(--text-muted)" }}>
                            Dateigröße
                          </span>
                          <span className="font-medium tabular-nums">
                            {formatBytes(securityInfo.fileSize)}
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between">
                          <span
                            className="text-[11px] font-semibold uppercase tracking-wider"
                            style={{ color: "var(--text-muted)" }}
                          >
                            SHA-256 Hash
                          </span>
                          <button
                            onClick={() =>
                              copyText(securityInfo.sha256, "SHA-256")
                            }
                            className="text-[11px] flex items-center gap-1 hover:underline cursor-pointer"
                            style={{ color: "var(--accent-cpu)" }}
                          >
                            <Copy className="w-3 h-3" /> Kopieren
                          </button>
                        </div>
                        <div
                          className="p-2.5 rounded-xl text-[11px] font-mono break-all border select-text"
                          style={{
                            backgroundColor: "var(--bg-subtle)",
                            borderColor: "var(--border-subtle)",
                            color: "var(--text-secondary)",
                          }}
                        >
                          {securityInfo.sha256}
                        </div>
                      </div>

                      <button
                        onClick={async () => {
                          try {
                            await api.runNewTask(securityInfo.virustotalUrl);
                          } catch (err) {
                            onActionFeedback({
                              ok: false,
                              message: `Browser konnte nicht geöffnet werden: ${String(err)}`,
                            });
                          }
                        }}
                        className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold border transition-colors hover:bg-[var(--bg-surface-hover)] cursor-pointer"
                        style={{
                          backgroundColor: "var(--accent-cpu-soft)",
                          borderColor: "var(--accent-cpu)",
                          color: "var(--accent-cpu)",
                        }}
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        Auf VirusTotal prüfen
                      </button>
                    </>
                  ) : null}
                </div>
              )}

              {/* TAB 3: MODULES & THREADS (On-Demand) */}
              {tab === "modules" && (
                <div className="flex flex-col gap-3">
                  {isExited ? (
                    <div
                      className="p-4 rounded-xl border text-center text-xs"
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        borderColor: "var(--border-subtle)",
                        color: "var(--text-muted)",
                      }}
                    >
                      Module &amp; Threads sind für bereits beendete Prozesse
                      (Archiv-Modus) nicht mehr verfügbar.
                    </div>
                  ) : modulesLoading ? (
                    <div
                      className="p-6 text-center text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Lade Module & Threads…
                    </div>
                  ) : modulesError ? (
                    <div
                      className="p-3 rounded-xl border text-xs"
                      style={{
                        backgroundColor: "var(--accent-danger-soft)",
                        borderColor: "var(--accent-danger)",
                        color: "var(--accent-danger)",
                      }}
                    >
                      {modulesError}
                    </div>
                  ) : modulesInfo ? (
                    <>
                      <div
                        className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl border"
                        style={{
                          backgroundColor: "var(--bg-subtle)",
                          borderColor: "var(--border-subtle)",
                        }}
                      >
                        <Search
                          className="w-3.5 h-3.5 shrink-0"
                          style={{ color: "var(--text-muted)" }}
                        />
                        <input
                          value={moduleFilter}
                          onChange={(e) => setModuleFilter(e.target.value)}
                          placeholder="DLL oder Pfad filtern…"
                          className="bg-transparent outline-none text-xs flex-1"
                          style={{ color: "var(--text-primary)" }}
                        />
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <span
                          className="text-[11px] font-semibold uppercase tracking-wider flex items-center gap-1.5"
                          style={{ color: "var(--text-muted)" }}
                        >
                          <Layers className="w-3 h-3" /> Geladene Module (
                          {filteredModules.length} / {modulesInfo.totalModules})
                        </span>
                        <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
                          {filteredModules.map((m, idx) => (
                            <div
                              key={`${m.name}-${idx}`}
                              className="px-2.5 py-1.5 rounded-lg border text-[11px]"
                              style={{
                                backgroundColor: "var(--bg-subtle)",
                                borderColor: "var(--border-subtle)",
                              }}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-semibold truncate">
                                  {m.name}
                                </span>
                                <span
                                  className="tabular-nums shrink-0"
                                  style={{ color: "var(--text-muted)" }}
                                >
                                  {formatBytes(m.sizeBytes)}
                                </span>
                              </div>
                              {m.path && (
                                <div
                                  className="text-[10px] font-mono truncate mt-0.5"
                                  style={{ color: "var(--text-muted)" }}
                                  title={m.path}
                                >
                                  {m.path}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <span
                          className="text-[11px] font-semibold uppercase tracking-wider"
                          style={{ color: "var(--text-muted)" }}
                        >
                          Threads ({modulesInfo.threads.length} /{" "}
                          {modulesInfo.totalThreads})
                        </span>
                        <div className="grid grid-cols-2 gap-1 max-h-48 overflow-y-auto">
                          {modulesInfo.threads.map((th) => (
                            <div
                              key={th.tid}
                              className="px-2 py-1 rounded-lg border text-[11px] flex items-center justify-between tabular-nums"
                              style={{
                                backgroundColor: "var(--bg-subtle)",
                                borderColor: "var(--border-subtle)",
                              }}
                            >
                              <span className="font-mono font-medium">
                                TID {th.tid}
                              </span>
                              <span style={{ color: "var(--text-muted)" }}>
                                Prio {th.basePriority}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  ) : null}
                </div>
              )}

              {/* TAB 4: ENVIRONMENT (On-Demand) */}
              {tab === "env" && (
                <div className="flex flex-col gap-3">
                  {isExited ? (
                    <div
                      className="p-4 rounded-xl border text-center text-xs"
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        borderColor: "var(--border-subtle)",
                        color: "var(--text-muted)",
                      }}
                    >
                      Umgebungsvariablen sind für bereits beendete Prozesse
                      (Archiv-Modus) nicht mehr verfügbar.
                    </div>
                  ) : envLoading ? (
                    <div
                      className="p-6 text-center text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Lese Arbeitsverzeichnis & Umgebungsvariablen…
                    </div>
                  ) : envError ? (
                    <div
                      className="p-3 rounded-xl border text-xs"
                      style={{
                        backgroundColor: "var(--accent-danger-soft)",
                        borderColor: "var(--accent-danger)",
                        color: "var(--accent-danger)",
                      }}
                    >
                      {envError}
                    </div>
                  ) : envInfo ? (
                    <>
                      {envInfo.cwd && (
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center justify-between">
                            <span
                              className="text-[11px] font-semibold uppercase tracking-wider"
                              style={{ color: "var(--text-muted)" }}
                            >
                              Arbeitsverzeichnis (CWD)
                            </span>
                            <button
                              onClick={() =>
                                copyText(envInfo.cwd!, "Arbeitsverzeichnis")
                              }
                              className="text-[11px] flex items-center gap-1 hover:underline cursor-pointer"
                              style={{ color: "var(--accent-cpu)" }}
                            >
                              <Copy className="w-3 h-3" /> Kopieren
                            </button>
                          </div>
                          <div
                            className="p-2.5 rounded-xl text-[11px] font-mono break-all border select-text"
                            style={{
                              backgroundColor: "var(--bg-subtle)",
                              borderColor: "var(--border-subtle)",
                              color: "var(--text-secondary)",
                            }}
                          >
                            {envInfo.cwd}
                          </div>
                        </div>
                      )}

                      <div
                        className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl border"
                        style={{
                          backgroundColor: "var(--bg-subtle)",
                          borderColor: "var(--border-subtle)",
                        }}
                      >
                        <Search
                          className="w-3.5 h-3.5 shrink-0"
                          style={{ color: "var(--text-muted)" }}
                        />
                        <input
                          value={envFilter}
                          onChange={(e) => setEnvFilter(e.target.value)}
                          placeholder="Variable oder Wert filtern…"
                          className="bg-transparent outline-none text-xs flex-1"
                          style={{ color: "var(--text-primary)" }}
                        />
                      </div>

                      <div className="flex flex-col gap-1">
                        {filteredEnvVars.map(([k, v], idx) => (
                          <div
                            key={`${k}-${idx}`}
                            className="px-2.5 py-1.5 rounded-lg border text-[11px]"
                            style={{
                              backgroundColor: "var(--bg-subtle)",
                              borderColor: "var(--border-subtle)",
                            }}
                          >
                            <div
                              className="font-mono font-semibold truncate"
                              style={{ color: "var(--accent-cpu)" }}
                            >
                              {k}
                            </div>
                            <div
                              className="font-mono text-[10px] break-all mt-0.5 select-text"
                              style={{ color: "var(--text-secondary)" }}
                            >
                              {v}
                            </div>
                          </div>
                        ))}
                        {envInfo.truncated && (
                          <div
                            className="text-[10px] text-center py-1"
                            style={{ color: "var(--text-muted)" }}
                          >
                            Umgebungsvariablen wurden aus Performance-Gründen
                            gekürzt.
                          </div>
                        )}
                      </div>
                    </>
                  ) : null}
                </div>
              )}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    );
  }
);

ProcessInspector.displayName = "ProcessInspector";
