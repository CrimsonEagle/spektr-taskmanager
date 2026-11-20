import React, { useMemo } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BatteryCharging,
  Cpu,
  FileLock2,
  Gpu,
  HardDrive,
  MemoryStick,
  Network,
  RefreshCw,
  Thermometer,
  Wifi,
  Zap,
} from "lucide-react";
import { Sparkline } from "../components/charts/Sparkline";
import {
  formatBytes,
  formatDuration,
  formatSpeed,
  formatTimeShort,
  getCategoryMeta,
} from "../lib/format";
import {
  BlameProcess,
  HistoryPoint,
  NavTab,
  PerformanceMetric,
  TelemetrySnapshot,
} from "../types/telemetry";

interface OverviewViewProps {
  snapshot: TelemetrySnapshot;
  history: HistoryPoint[];
  onInspectPid: (pid: number, fallback?: BlameProcess) => void;
  onNavigate: (tab: NavTab) => void;
  onOpenPerformanceMetric: (metric: PerformanceMetric) => void;
  onJumpToSpike: (timestampMs: number) => void;
  onRestartExplorer: () => void;
}

const cardAnim = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0 },
};

export const OverviewView: React.FC<OverviewViewProps> = React.memo(({
  snapshot,
  history,
  onInspectPid,
  onNavigate,
  onOpenPerformanceMetric,
  onJumpToSpike,
  onRestartExplorer,
}) => {
  const recent = useMemo(() => history.slice(-45), [history]);
  const cpuSeries = useMemo(() => recent.map((h) => h.cpuPercent), [recent]);
  const ramSeries = useMemo(() => recent.map((h) => h.ramPercent), [recent]);
  const gpuSeries = useMemo(() => recent.map((h) => h.gpuPercent), [recent]);
  const diskSeries = useMemo(
    () => recent.map((h) => h.diskActivePercent ?? h.diskMbPerSec),
    [recent]
  );
  const netSeries = useMemo(() => recent.map((h) => h.netKbPerSec), [recent]);

  const recentSpikes = useMemo(
    () => history.filter((h) => h.isSpike && h.spikeReason).slice(-4).reverse(),
    [history]
  );

  const { cpu, memory, gpu, disk, network, battery, system } = snapshot;
  const vramPct =
    gpu.vramTotalBytes > 0
      ? (gpu.vramUsedBytes / gpu.vramTotalBytes) * 100
      : 0;
  const cachedPct =
    memory.totalBytes > 0
      ? (memory.cachedBytes / memory.totalBytes) * 100
      : 0;

  return (
    <motion.div
      initial="hidden"
      animate="show"
      variants={{ show: { transition: { staggerChildren: 0.04 } } }}
      className="flex flex-col gap-4 pb-6"
    >
      {/* Detected Spikes Alert Strip (only shown when spikes exist) */}
      {recentSpikes.length > 0 && (
        <motion.div
          variants={cardAnim}
          className="fluent-card px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap"
          style={{ borderColor: "rgba(239, 68, 68, 0.32)" }}
        >
          <div className="flex items-center gap-2 text-xs font-medium">
            <span className="w-6 h-6 rounded-lg bg-red-500/15 text-red-500 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-3.5 h-3.5" />
            </span>
            <span className="font-semibold">Letzte Lastspitzen erkannt:</span>
            <div className="flex items-center gap-1.5 flex-wrap">
              {recentSpikes.map((sp) => (
                <button
                  key={sp.timestampMs}
                  onClick={() => onJumpToSpike(sp.timestampMs)}
                  className="px-2 py-0.5 rounded-md text-[11px] font-medium cursor-pointer transition-colors hover:opacity-85"
                  style={{
                    backgroundColor: "var(--accent-danger-soft)",
                    color: "var(--accent-danger)",
                  }}
                >
                  {formatTimeShort(sp.timestampMs)} — {sp.spikeReason}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={() => onNavigate("performance")}
            className="text-xs font-semibold hover:underline cursor-pointer"
            style={{ color: "var(--accent-cpu)" }}
          >
            Spike-Analyse öffnen →
          </button>
        </motion.div>
      )}

      {/* Main Resource Bento Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {/* CPU Card */}
        <motion.div
          variants={cardAnim}
          onClick={() => onOpenPerformanceMetric("cpu")}
          className="fluent-card p-4 flex flex-col justify-between gap-3 cursor-pointer overflow-hidden min-w-0"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                style={{
                  backgroundColor: "var(--accent-cpu-soft)",
                  color: "var(--accent-cpu)",
                }}
              >
                <Cpu className="w-4.5 h-4.5" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold">Prozessor (CPU)</div>
                <div
                  className="text-[11px] truncate"
                  style={{ color: "var(--text-muted)" }}
                  title={cpu.brand}
                >
                  {cpu.brand}
                </div>
              </div>
            </div>
            <div className="text-right shrink-0">
              <div
                className="text-2xl font-bold tabular-nums leading-none"
                style={{ color: "var(--accent-cpu)" }}
              >
                {cpu.totalUsage.toFixed(0)}%
              </div>
              <div
                className="text-[11px] tabular-nums mt-1 flex items-center justify-end gap-1.5 flex-wrap"
                style={{ color: "var(--text-muted)" }}
                title={[
                  cpu.baseFrequencyMhz && cpu.baseFrequencyMhz > 0
                    ? `Basistakt: ${(cpu.baseFrequencyMhz / 1000).toFixed(2)} GHz`
                    : null,
                  cpu.sensorSource ? `Sensoren: ${cpu.sensorSource}` : null,
                ]
                  .filter(Boolean)
                  .join(" • ") || undefined}
              >
                <span>{(cpu.frequencyMhz / 1000).toFixed(2)} GHz</span>
                {cpu.temperatureC != null && (
                  <span className="inline-flex items-center gap-0.5">
                    <Thermometer className="w-3 h-3" />
                    {cpu.temperatureC.toFixed(0)}°C
                  </span>
                )}
                {cpu.powerWatts != null && (
                  <span className="inline-flex items-center gap-0.5">
                    <Zap className="w-3 h-3" />
                    {cpu.powerWatts.toFixed(0)}W
                  </span>
                )}
              </div>
            </div>
          </div>

          <Sparkline
            data={cpuSeries}
            color="var(--accent-cpu)"
            width={300}
            height={42}
            maxValue={100}
            className="w-full"
            showEndDot
          />

          {/* Per-Core Heatmap */}
          <div>
            <div className="flex items-center justify-between text-[10px] mb-1.5">
              <span style={{ color: "var(--text-muted)" }}>
                Kern-Heatmap ({cpu.physicalCores}P / {cpu.logicalCores}T)
              </span>
              <span style={{ color: "var(--text-muted)" }}>0% → 100%</span>
            </div>
            <div
              className="grid gap-1"
              style={{
                gridTemplateColumns: `repeat(${Math.min(16, Math.max(4, cpu.perCore.length))}, minmax(0, 1fr))`,
              }}
            >
              {cpu.perCore.map((val, idx) => {
                const intensity = Math.max(0.12, Math.min(1, val / 100));
                const bg =
                  val > 80
                    ? `rgba(239, 68, 68, ${intensity})`
                    : val > 55
                      ? `rgba(249, 115, 22, ${intensity})`
                      : `rgba(14, 165, 233, ${intensity})`;
                return (
                  <div
                    key={idx}
                    title={`Kern #${idx}: ${val.toFixed(0)}%`}
                    className="h-3.5 rounded-[4px] transition-colors duration-300"
                    style={{ backgroundColor: bg }}
                  />
                );
              })}
            </div>
          </div>
        </motion.div>

        {/* RAM Card */}
        <motion.div
          variants={cardAnim}
          onClick={() => onOpenPerformanceMetric("memory")}
          className="fluent-card p-4 flex flex-col justify-between gap-3 cursor-pointer overflow-hidden min-w-0"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                style={{
                  backgroundColor: "var(--accent-ram-soft)",
                  color: "var(--accent-ram)",
                }}
              >
                <MemoryStick className="w-4.5 h-4.5" />
              </div>
              <div>
                <div className="text-xs font-semibold">Arbeitsspeicher (RAM)</div>
                <div
                  className="text-[11px] tabular-nums"
                  style={{ color: "var(--text-muted)" }}
                >
                  {formatBytes(memory.usedBytes)} / {formatBytes(memory.totalBytes)}
                </div>
              </div>
            </div>
            <div className="text-right">
              <div
                className="text-2xl font-bold tabular-nums leading-none"
                style={{ color: "var(--accent-ram)" }}
              >
                {memory.usagePercent.toFixed(0)}%
              </div>
              <div
                className="text-[11px] tabular-nums mt-1"
                style={{ color: "var(--text-muted)" }}
              >
                Frei: {formatBytes(memory.availableBytes)}
              </div>
            </div>
          </div>

          <Sparkline
            data={ramSeries}
            color="var(--accent-ram)"
            width={300}
            height={42}
            maxValue={100}
            className="w-full"
            showEndDot
          />

          {/* Segmented RAM Bar */}
          <div>
            <div
              className="relative h-2.5 w-full rounded-full overflow-hidden"
              style={{ backgroundColor: "var(--bg-subtle)" }}
              title={`Aktiv: ${formatBytes(memory.usedBytes)} • Standby/Cache: ${formatBytes(memory.cachedBytes)}`}
            >
              <div
                className="absolute inset-0 rounded-full origin-left transition-transform duration-500 opacity-40"
                style={{
                  transform: `scaleX(${Math.min(1, Math.max(0, (memory.usagePercent + cachedPct) / 100))})`,
                  backgroundColor: "var(--accent-ram)",
                }}
              />
              <div
                className="absolute inset-0 rounded-full origin-left transition-transform duration-500"
                style={{
                  transform: `scaleX(${Math.min(1, Math.max(0, memory.usagePercent / 100))})`,
                  backgroundColor: "var(--accent-ram)",
                }}
              />
            </div>
            <div
              className="flex items-center justify-between text-[11px] mt-2 tabular-nums"
              style={{ color: "var(--text-muted)" }}
            >
              <span>Auslagerung (Swap)</span>
              <span>
                {formatBytes(memory.swapUsedBytes)} / {formatBytes(memory.swapTotalBytes)}
              </span>
            </div>
            {((memory.commitTotalBytes ?? 0) > 0 ||
              (memory.pagedPoolBytes ?? 0) > 0 ||
              (memory.nonPagedPoolBytes ?? 0) > 0) && (
              <div
                className="flex items-center justify-between gap-2 text-[10px] mt-1 tabular-nums flex-wrap"
                style={{ color: "var(--text-muted)" }}
              >
                {(memory.commitTotalBytes ?? 0) > 0 && (
                  <span>
                    Commit: {formatBytes(memory.commitTotalBytes ?? 0)}
                    {(memory.commitLimitBytes ?? 0) > 0
                      ? ` / ${formatBytes(memory.commitLimitBytes ?? 0)}`
                      : ""}
                  </span>
                )}
                {((memory.pagedPoolBytes ?? 0) > 0 ||
                  (memory.nonPagedPoolBytes ?? 0) > 0) && (
                  <span>
                    Pool: {formatBytes(memory.pagedPoolBytes ?? 0)} P /{" "}
                    {formatBytes(memory.nonPagedPoolBytes ?? 0)} NP
                  </span>
                )}
              </div>
            )}
          </div>
        </motion.div>

        {/* GPU Card */}
        <motion.div
          variants={cardAnim}
          onClick={() => onOpenPerformanceMetric("gpu")}
          className="fluent-card p-4 flex flex-col justify-between gap-3 cursor-pointer overflow-hidden min-w-0"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                style={{
                  backgroundColor: "var(--accent-gpu-soft)",
                  color: "var(--accent-gpu)",
                }}
              >
                <Gpu className="w-4.5 h-4.5" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold">Grafikkarte (GPU)</div>
                <div
                  className="text-[11px] truncate"
                  style={{ color: "var(--text-muted)" }}
                  title={gpu.name}
                >
                  {gpu.name}
                </div>
              </div>
            </div>
            <div className="text-right shrink-0">
              <div
                className="text-2xl font-bold tabular-nums leading-none"
                style={{ color: "var(--accent-gpu)" }}
              >
                {gpu.usagePercent != null ? `${gpu.usagePercent.toFixed(0)}%` : "–"}
              </div>
              <div
                className="text-[11px] tabular-nums mt-1 flex items-center justify-end gap-2"
                style={{ color: "var(--text-muted)" }}
              >
                {gpu.temperatureC != null && (
                  <span className="inline-flex items-center gap-0.5">
                    <Thermometer className="w-3 h-3" />
                    {gpu.temperatureC.toFixed(0)}°C
                  </span>
                )}
                {gpu.powerWatts != null && (
                  <span className="inline-flex items-center gap-0.5">
                    <Zap className="w-3 h-3" />
                    {gpu.powerWatts.toFixed(0)}W
                  </span>
                )}
              </div>
            </div>
          </div>

          <Sparkline
            data={gpuSeries}
            color="var(--accent-gpu)"
            width={300}
            height={42}
            maxValue={100}
            className="w-full"
            showEndDot
          />

          <div>
            <div className="flex items-center justify-between text-[11px] mb-1.5 tabular-nums">
              <span style={{ color: "var(--text-muted)" }}>Dedizierter VRAM</span>
              <span>
                {gpu.vramTotalBytes > 0
                  ? `${formatBytes(gpu.vramUsedBytes)} / ${formatBytes(gpu.vramTotalBytes)}`
                  : "Geteilter Speicher"}
              </span>
            </div>
            <div
              className="h-2.5 w-full rounded-full overflow-hidden"
              style={{ backgroundColor: "var(--bg-subtle)" }}
            >
              <div
                className="h-full w-full rounded-full origin-left transition-transform duration-500"
                style={{
                  transform: `scaleX(${Math.min(1, Math.max(0, vramPct / 100))})`,
                  backgroundColor: "var(--accent-gpu)",
                }}
              />
            </div>
            <div
              className="flex items-center justify-between gap-2 text-[10px] mt-1.5 tabular-nums"
              style={{ color: "var(--text-muted)" }}
            >
              <span>
                3D {(gpu.engine3dPercent ?? 0).toFixed(0)}% · Dec{" "}
                {(gpu.engineVideoDecodePercent ?? 0).toFixed(0)}% · Enc{" "}
                {(gpu.engineVideoEncodePercent ?? 0).toFixed(0)}%
              </span>
              {(gpu.sharedTotalBytes ?? 0) > 0 && (
                <span className="truncate">
                  Geteilt: {formatBytes(gpu.sharedUsedBytes ?? 0)} /{" "}
                  {formatBytes(gpu.sharedTotalBytes ?? 0)}
                </span>
              )}
            </div>
          </div>
        </motion.div>

        {/* Disk Card */}
        <motion.div
          variants={cardAnim}
          onClick={() => onOpenPerformanceMetric("disk")}
          className="fluent-card p-4 flex flex-col justify-between gap-3 cursor-pointer overflow-hidden min-w-0"
        >
          <div className="flex items-start justify-between gap-2 min-w-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                style={{
                  backgroundColor: "var(--accent-disk-soft)",
                  color: "var(--accent-disk)",
                }}
              >
                <HardDrive className="w-4.5 h-4.5" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold truncate">Datenträger</div>
                <div
                  className="text-[11px] tabular-nums truncate"
                  style={{ color: "var(--text-muted)" }}
                >
                  R: {formatSpeed(disk.readBytesPerSec)} • W:{" "}
                  {formatSpeed(disk.writeBytesPerSec)}
                </div>
              </div>
            </div>
            <div className="text-right shrink-0">
              <div
                className="text-2xl font-bold tabular-nums leading-none"
                style={{ color: "var(--accent-disk)" }}
              >
                {(disk.activePercent ?? 0).toFixed(0)}%
              </div>
              <div
                className="text-[11px] tabular-nums mt-1"
                style={{ color: "var(--text-muted)" }}
                title="Durchschnittliche Antwortzeit"
              >
                {(disk.avgResponseMs ?? 0).toFixed(1)} ms
              </div>
            </div>
          </div>

          <Sparkline
            data={diskSeries}
            color="var(--accent-disk)"
            width={300}
            height={34}
            maxValue={100}
            className="w-full block"
          />

          <div className="flex flex-col gap-2">
            {disk.drives.slice(0, 3).map((d) => (
              <div key={d.mountPoint} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2 text-[11px] tabular-nums">
                  <span
                    className="font-medium truncate"
                    title={d.model ?? undefined}
                  >
                    {d.mountPoint}{" "}
                    {d.busType ? `(${d.busType})` : d.name ? `(${d.name})` : ""}
                    {(d.activePercent ?? 0) >= 1 && (
                      <span
                        className="ml-1.5 text-[10px] font-semibold"
                        style={{ color: "var(--accent-disk)" }}
                      >
                        {(d.activePercent ?? 0).toFixed(0)}%
                      </span>
                    )}
                  </span>
                  <span className="shrink-0" style={{ color: "var(--text-muted)" }}>
                    {formatBytes(d.availableBytes)} frei / {formatBytes(d.totalBytes)}
                  </span>
                </div>
                <div
                  className="h-1.5 w-full rounded-full overflow-hidden"
                  style={{ backgroundColor: "var(--bg-subtle)" }}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${d.usagePercent}%`,
                      backgroundColor:
                        d.usagePercent > 90
                          ? "var(--accent-danger)"
                          : "var(--accent-disk)",
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </motion.div>

        {/* Network Card */}
        <motion.div
          variants={cardAnim}
          onClick={() => onOpenPerformanceMetric("network")}
          className="fluent-card p-4 flex flex-col justify-between gap-3 cursor-pointer overflow-hidden min-w-0"
        >
          <div className="flex items-start justify-between gap-2 min-w-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                style={{
                  backgroundColor: "var(--accent-net-soft)",
                  color: "var(--accent-net)",
                }}
              >
                <Wifi className="w-4.5 h-4.5" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold truncate">Netzwerk</div>
                <div
                  className="text-[11px] truncate"
                  style={{ color: "var(--text-muted)" }}
                >
                  {network.primaryInterface}
                </div>
              </div>
            </div>
          </div>

          <Sparkline
            data={netSeries}
            color="var(--accent-net)"
            width={300}
            height={34}
            className="w-full block"
          />

          <div className="grid grid-cols-2 gap-2.5 tabular-nums">
            <div
              className="p-2.5 rounded-xl border"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <div
                className="text-[10px] flex items-center gap-1"
                style={{ color: "var(--text-muted)" }}
              >
                <ArrowDown className="w-3 h-3 text-rose-500" /> Download
              </div>
              <div
                className="text-sm font-bold mt-0.5"
                style={{ color: "var(--accent-net)" }}
              >
                {formatSpeed(network.rxBytesPerSec)}
              </div>
            </div>
            <div
              className="p-2.5 rounded-xl border"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <div
                className="text-[10px] flex items-center gap-1"
                style={{ color: "var(--text-muted)" }}
              >
                <ArrowUp className="w-3 h-3 text-amber-500" /> Upload
              </div>
              <div
                className="text-sm font-bold mt-0.5"
                style={{ color: "var(--accent-disk)" }}
              >
                {formatSpeed(network.txBytesPerSec)}
              </div>
            </div>
          </div>

          <div
            className="flex items-center justify-between text-[11px] tabular-nums"
            style={{ color: "var(--text-muted)" }}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                onNavigate("network");
              }}
              className="hover:underline cursor-pointer"
              style={{ color: "var(--accent-net)" }}
            >
              Offene Ports: {system.listeningPortsCount} →
            </button>
            <span>Sitzung: ↓ {formatBytes(network.totalRxBytes)}</span>
          </div>
        </motion.div>

        {/* System / Battery & Quick Actions Card */}
        <motion.div
          variants={cardAnim}
          onClick={() => onNavigate("processes")}
          className="fluent-card p-4 flex flex-col justify-between gap-3 cursor-pointer overflow-hidden min-w-0"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-indigo-500/15 text-indigo-500 shrink-0">
                <BatteryCharging className="w-4.5 h-4.5" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold truncate">
                  {battery.hasBattery ? "Akku & System" : "System & Schnellzugriff"}
                </div>
                <div
                  className="text-[11px] truncate"
                  style={{ color: "var(--text-muted)" }}
                >
                  {battery.hasBattery
                    ? `${battery.percent ?? 0}% • ${battery.isCharging ? "Lädt" : battery.isAcPlugged ? "Netzbetrieb" : "Akkubetrieb"}`
                    : `${system.processCount} Prozesse • ${formatDuration(system.uptimeSeconds)}`}
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-1.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onNavigate("network");
              }}
              className="flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium border cursor-pointer transition-colors hover:bg-[var(--bg-surface-hover)]"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <span className="flex items-center gap-2">
                <Network className="w-3.5 h-3.5 text-rose-500" />
                Offene Ports prüfen
              </span>
              <span
                className="text-[11px] font-semibold tabular-nums"
                style={{ color: "var(--accent-net)" }}
              >
                {system.listeningPortsCount}
              </span>
            </button>

            <button
              onClick={(e) => {
                e.stopPropagation();
                onNavigate("tools");
              }}
              className="flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium border cursor-pointer transition-colors hover:bg-[var(--bg-surface-hover)]"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <span className="flex items-center gap-2">
                <FileLock2 className="w-3.5 h-3.5 text-amber-500" />
                Wer blockiert eine Datei?
              </span>
              <span style={{ color: "var(--text-muted)" }}>→</span>
            </button>

            <button
              onClick={(e) => {
                e.stopPropagation();
                onRestartExplorer();
              }}
              className="flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium border cursor-pointer transition-colors hover:bg-[var(--bg-surface-hover)]"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <span className="flex items-center gap-2">
                <RefreshCw className="w-3.5 h-3.5 text-sky-500" />
                Windows Explorer neu starten
              </span>
              <span style={{ color: "var(--text-muted)" }}>Aktion</span>
            </button>
          </div>
        </motion.div>
      </div>

      {/* Top Consumers Spotlight */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Top CPU */}
        <motion.div variants={cardAnim} className="fluent-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <span
                className="w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: "var(--accent-cpu)" }}
              />
              Top CPU-Verbraucher
            </h3>
            <button
              onClick={() => onNavigate("processes")}
              className="text-xs font-medium hover:underline cursor-pointer"
              style={{ color: "var(--accent-cpu)" }}
            >
              Alle Prozesse →
            </button>
          </div>
          <div className="flex flex-col gap-2">
            {snapshot.latestPoint.topCpu.map((p) => {
              const cat = getCategoryMeta(p.category);
              return (
                <button
                  key={p.pid}
                  onClick={() => onInspectPid(p.pid, p)}
                  className="flex items-center justify-between gap-3 p-2 rounded-xl transition-colors hover:bg-[var(--bg-surface-hover)] cursor-pointer text-left"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: cat.color }}
                    />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold truncate">{p.name}</div>
                      {p.subtitle && (
                        <div
                          className="text-[11px] truncate"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {p.subtitle}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div
                      className="w-24 h-1.5 rounded-full overflow-hidden hidden sm:block"
                      style={{ backgroundColor: "var(--bg-subtle)" }}
                    >
                      <div
                        className="h-full w-full rounded-full origin-left transition-transform duration-300"
                        style={{
                          transform: `scaleX(${Math.min(1, Math.max(0.04, p.cpuPercent / 100))})`,
                          backgroundColor: "var(--accent-cpu)",
                        }}
                      />
                    </div>
                    <span
                      className="text-xs font-bold tabular-nums w-12 text-right"
                      style={{ color: "var(--accent-cpu)" }}
                    >
                      {p.cpuPercent.toFixed(1)}%
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </motion.div>

        {/* Top RAM */}
        <motion.div variants={cardAnim} className="fluent-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <span
                className="w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: "var(--accent-ram)" }}
              />
              Top RAM-Verbraucher
            </h3>
            <button
              onClick={() => onNavigate("processes")}
              className="text-xs font-medium hover:underline cursor-pointer"
              style={{ color: "var(--accent-ram)" }}
            >
              Alle Prozesse →
            </button>
          </div>
          <div className="flex flex-col gap-2">
            {snapshot.latestPoint.topRam.map((p) => {
              const cat = getCategoryMeta(p.category);
              const pct =
                memory.totalBytes > 0
                  ? (p.memoryBytes / memory.totalBytes) * 100
                  : 0;
              return (
                <button
                  key={p.pid}
                  onClick={() => onInspectPid(p.pid, p)}
                  className="flex items-center justify-between gap-3 p-2 rounded-xl transition-colors hover:bg-[var(--bg-surface-hover)] cursor-pointer text-left"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: cat.color }}
                    />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold truncate">{p.name}</div>
                      {p.subtitle && (
                        <div
                          className="text-[11px] truncate"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {p.subtitle}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div
                      className="w-24 h-1.5 rounded-full overflow-hidden hidden sm:block"
                      style={{ backgroundColor: "var(--bg-subtle)" }}
                    >
                      <div
                        className="h-full w-full rounded-full origin-left transition-transform duration-300"
                        style={{
                          transform: `scaleX(${Math.min(1, Math.max(0.04, (pct * 2.5) / 100))})`,
                          backgroundColor: "var(--accent-ram)",
                        }}
                      />
                    </div>
                    <span
                      className="text-xs font-bold tabular-nums w-16 text-right"
                      style={{ color: "var(--accent-ram)" }}
                    >
                      {formatBytes(p.memoryBytes)}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
});

OverviewView.displayName = "OverviewView";
