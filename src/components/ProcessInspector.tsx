import React, { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Copy,
  FolderOpen,
  GitBranch,
  Leaf,
  Network,
  Pause,
  Play,
  Skull,
  Snowflake,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
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
  ProcessEntry,
} from "../types/telemetry";
import { Sparkline } from "./charts/Sparkline";

interface ProcessInspectorProps {
  process: ProcessEntry | null;
  allProcesses: ProcessEntry[];
  onClose: () => void;
  onSelectPid: (pid: number) => void;
  onActionFeedback: (res: ActionResult) => void;
}

export const ProcessInspector: React.FC<ProcessInspectorProps> = ({
  process,
  allProcesses,
  onClose,
  onSelectPid,
  onActionFeedback,
}) => {
  const [ports, setPorts] = useState<NetworkConnectionEntry[]>([]);
  const [priority, setPriority] = useState("normal");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!process) return;
    let active = true;
    api
      .getNetworkConnections()
      .then((list) => {
        if (!active) return;
        setPorts(list.filter((c) => c.pid === process.pid));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [process?.pid]);

  const parentProc = process?.parentPid
    ? allProcesses.find((p) => p.pid === process.parentPid)
    : undefined;
  const children = process
    ? allProcesses.filter((p) => p.parentPid === process.pid)
    : [];

  const runAction = async (fn: () => Promise<ActionResult>, closeAfter = false) => {
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

  const copyText = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
      onActionFeedback({ ok: true, message: `${label} in Zwischenablage kopiert.` });
    });
  };

  const cat = process ? getCategoryMeta(process.category) : null;

  return (
    <AnimatePresence>
      {process && cat && (
        <motion.aside
          key="inspector"
          initial={{ x: 420, opacity: 0.4 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 420, opacity: 0 }}
          transition={{ type: "spring", stiffness: 380, damping: 34 }}
          className="w-[390px] shrink-0 h-full border-l flex flex-col overflow-hidden z-20"
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
                className="w-10 h-10 rounded-xl flex items-center justify-center font-bold text-xs shrink-0"
                style={{
                  backgroundColor: cat.softBg,
                  color: cat.color,
                  border: `1px solid ${cat.color}33`,
                }}
              >
                {getProcessMonogram(process.name)}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-sm truncate">{process.name}</h3>
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

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
            {/* Live Badges */}
            {(process.isSuspended || process.isEfficiencyMode) && (
              <div className="flex flex-wrap gap-1.5">
                {process.isSuspended && (
                  <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-sky-500/15 text-sky-500 font-medium">
                    <Snowflake className="w-3.5 h-3.5" />
                    Prozess eingefroren
                  </span>
                )}
                {process.isEfficiencyMode && (
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
                  className="text-[11px] font-medium mb-1"
                  style={{ color: "var(--text-muted)" }}
                >
                  CPU-Last (30s)
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
              <div
                className="text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: "var(--text-muted)" }}
              >
                Aktionen
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  disabled={busy}
                  onClick={() => runAction(() => api.killProcess(process.pid), true)}
                  className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-colors cursor-pointer"
                  style={{
                    backgroundColor: "var(--accent-danger-soft)",
                    color: "var(--accent-danger)",
                  }}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Beenden
                </button>
                <button
                  disabled={busy}
                  onClick={() => runAction(() => api.killProcessTree(process.pid), true)}
                  className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-colors cursor-pointer border"
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
                  disabled={busy}
                  onClick={() =>
                    runAction(() =>
                      api.setProcessSuspended(process.pid, !process.isSuspended)
                    )
                  }
                  className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-colors cursor-pointer border"
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
                  disabled={busy}
                  onClick={() =>
                    runAction(() =>
                      api.setEfficiencyMode(process.pid, !process.isEfficiencyMode)
                    )
                  }
                  className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-colors cursor-pointer border"
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
              </div>

              {/* Priority & Open Folder */}
              <div className="flex items-center gap-2 mt-1">
                <select
                  value={priority}
                  onChange={(e) => {
                    const val = e.target.value;
                    setPriority(val);
                    runAction(() => api.setProcessPriority(process.pid, val));
                  }}
                  className="flex-1 px-2.5 py-2 rounded-xl text-xs font-medium border outline-none cursor-pointer"
                  style={{
                    backgroundColor: "var(--bg-surface-solid)",
                    borderColor: "var(--border-subtle)",
                    color: "var(--text-primary)",
                  }}
                >
                  <option value="idle">Priorität: Niedrig (Idle)</option>
                  <option value="below_normal">Priorität: Niedriger als Normal</option>
                  <option value="normal">Priorität: Normal</option>
                  <option value="above_normal">Priorität: Höher als Normal</option>
                  <option value="high">Priorität: Hoch</option>
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

            {/* I/O & System Stats */}
            <div
              className="p-3 rounded-xl border flex flex-col gap-2 text-xs"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <div className="flex justify-between">
                <span style={{ color: "var(--text-muted)" }}>Datenträger Lesen / Schreiben</span>
                <span className="font-medium tabular-nums">
                  {formatSpeed(process.diskReadBytesPerSec)} /{" "}
                  {formatSpeed(process.diskWriteBytesPerSec)}
                </span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: "var(--text-muted)" }}>Gesamt-I/O (R / W)</span>
                <span className="font-medium tabular-nums">
                  {formatBytes(process.totalDiskReadBytes)} /{" "}
                  {formatBytes(process.totalDiskWriteBytes)}
                </span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: "var(--text-muted)" }}>Offene Handles</span>
                <span className="font-medium tabular-nums">
                  {process.handleCount ?? "–"}
                </span>
              </div>
              {parentProc && (
                <div className="flex justify-between items-center">
                  <span style={{ color: "var(--text-muted)" }}>Elternprozess</span>
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
                    onClick={() => copyText(process.cmdLine, "Kommandozeile")}
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
                  <Network className="w-3 h-3" /> Netzwerk & Ports ({ports.length})
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
                  <GitBranch className="w-3 h-3" /> Kindprozesse ({children.length})
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
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
};
