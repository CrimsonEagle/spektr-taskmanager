import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Cpu,
  Gpu,
  HardDrive,
  History,
  MemoryStick,
  Thermometer,
  Wifi,
  Zap,
} from "lucide-react";
import { InteractiveAreaChart } from "../components/charts/InteractiveAreaChart";
import {
  formatBytes,
  formatSpeed,
  formatTimeShort,
  getCategoryMeta,
} from "../lib/format";
import { HistoryPoint, TelemetrySnapshot } from "../types/telemetry";

interface PerformanceViewProps {
  snapshot: TelemetrySnapshot;
  history: HistoryPoint[];
  initialSpikeTimestamp?: number | null;
  onClearInitialSpike?: () => void;
  onInspectPid: (pid: number) => void;
}

type MetricKey = "cpu" | "ram" | "gpu" | "disk" | "net";
type TimeWindow = 60 | 300 | 900;

export const PerformanceView: React.FC<PerformanceViewProps> = ({
  snapshot,
  history,
  initialSpikeTimestamp,
  onClearInitialSpike,
  onInspectPid,
}) => {
  const [metric, setMetric] = useState<MetricKey>("cpu");
  const [windowSec, setWindowSec] = useState<TimeWindow>(300);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const slicedHistory = useMemo(
    () => history.slice(-windowSec),
    [history, windowSec]
  );

  // If user jumped from a spike alert on Overview, auto-pin that timestamp
  useEffect(() => {
    if (!initialSpikeTimestamp) return;
    const idx = slicedHistory.findIndex(
      (h) => h.timestampMs === initialSpikeTimestamp
    );
    if (idx >= 0) {
      setSelectedIdx(idx);
    }
    onClearInitialSpike?.();
  }, [initialSpikeTimestamp, slicedHistory, onClearInitialSpike]);

  const metricConfig = {
    cpu: {
      label: "CPU",
      color: "var(--accent-cpu)",
      unit: "%",
      max: 100 as number | undefined,
      selector: (p: HistoryPoint) => p.cpuPercent,
      current: `${snapshot.cpu.totalUsage.toFixed(1)}%`,
      icon: <Cpu className="w-4 h-4" />,
    },
    ram: {
      label: "RAM",
      color: "var(--accent-ram)",
      unit: "%",
      max: 100 as number | undefined,
      selector: (p: HistoryPoint) => p.ramPercent,
      current: `${snapshot.memory.usagePercent.toFixed(1)}%`,
      icon: <MemoryStick className="w-4 h-4" />,
    },
    gpu: {
      label: "GPU",
      color: "var(--accent-gpu)",
      unit: "%",
      max: 100 as number | undefined,
      selector: (p: HistoryPoint) => p.gpuPercent,
      current:
        snapshot.gpu.usagePercent != null
          ? `${snapshot.gpu.usagePercent.toFixed(0)}%`
          : "–",
      icon: <Gpu className="w-4 h-4" />,
    },
    disk: {
      label: "Disk I/O",
      color: "var(--accent-disk)",
      unit: "MB/s",
      max: undefined,
      selector: (p: HistoryPoint) => p.diskMbPerSec,
      current: formatSpeed(
        snapshot.disk.readBytesPerSec + snapshot.disk.writeBytesPerSec
      ),
      icon: <HardDrive className="w-4 h-4" />,
    },
    net: {
      label: "Netzwerk",
      color: "var(--accent-net)",
      unit: "KB/s",
      max: undefined,
      selector: (p: HistoryPoint) => p.netKbPerSec,
      current: formatSpeed(
        snapshot.network.rxBytesPerSec + snapshot.network.txBytesPerSec
      ),
      icon: <Wifi className="w-4 h-4" />,
    },
  }[metric];

  const activePointIdx = hoverIdx ?? selectedIdx;
  const inspectedPoint =
    activePointIdx != null
      ? slicedHistory[activePointIdx] ?? snapshot.latestPoint
      : snapshot.latestPoint;

  const isHistoricalInspection =
    activePointIdx != null && activePointIdx < slicedHistory.length - 1;

  const detectedSpikes = useMemo(() => {
    const out: { idx: number; point: HistoryPoint }[] = [];
    slicedHistory.forEach((pt, idx) => {
      if (pt.isSpike) out.push({ idx, point: pt });
    });
    return out.slice(-8).reverse();
  }, [slicedHistory]);

  return (
    <div className="flex flex-col gap-4 pb-6">
      {/* Top Bar: Resource Selector + Time Window */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          {(
            [
              { id: "cpu", label: "CPU", val: `${snapshot.cpu.totalUsage.toFixed(0)}%`, color: "var(--accent-cpu)" },
              { id: "ram", label: "RAM", val: `${snapshot.memory.usagePercent.toFixed(0)}%`, color: "var(--accent-ram)" },
              { id: "gpu", label: "GPU", val: snapshot.gpu.usagePercent != null ? `${snapshot.gpu.usagePercent.toFixed(0)}%` : "–", color: "var(--accent-gpu)" },
              { id: "disk", label: "Disk", val: formatSpeed(snapshot.disk.readBytesPerSec + snapshot.disk.writeBytesPerSec), color: "var(--accent-disk)" },
              { id: "net", label: "Netzwerk", val: formatSpeed(snapshot.network.rxBytesPerSec + snapshot.network.txBytesPerSec), color: "var(--accent-net)" },
            ] as const
          ).map((tab) => {
            const active = metric === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setMetric(tab.id)}
                className="px-3 py-2 rounded-xl border text-xs font-semibold flex items-center gap-2 transition-all cursor-pointer tabular-nums"
                style={{
                  backgroundColor: active
                    ? "var(--bg-surface-solid)"
                    : "var(--bg-surface)",
                  borderColor: active ? tab.color : "var(--border-subtle)",
                  color: active ? tab.color : "var(--text-secondary)",
                  boxShadow: active ? "var(--shadow-card)" : "none",
                }}
              >
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: tab.color }}
                />
                <span>{tab.label}</span>
                <span className="opacity-80">{tab.val}</span>
              </button>
            );
          })}
        </div>

        {/* Time Window */}
        <div
          className="flex items-center p-1 rounded-xl border gap-0.5 text-xs"
          style={{
            backgroundColor: "var(--bg-surface)",
            borderColor: "var(--border-subtle)",
          }}
        >
          {(
            [
              { sec: 60, label: "1 Min" },
              { sec: 300, label: "5 Min" },
              { sec: 900, label: "15 Min" },
            ] as const
          ).map((w) => (
            <button
              key={w.sec}
              onClick={() => {
                setWindowSec(w.sec);
                setSelectedIdx(null);
              }}
              className="px-2.5 py-1 rounded-lg font-medium cursor-pointer transition-colors"
              style={{
                backgroundColor:
                  windowSec === w.sec
                    ? "var(--bg-surface-active)"
                    : "transparent",
                color:
                  windowSec === w.sec
                    ? "var(--text-primary)"
                    : "var(--text-muted)",
              }}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {/* Main Chart + Spike-Blame Panel */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-4">
        <div className="fluent-card p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span style={{ color: metricConfig.color }}>
                {metricConfig.icon}
              </span>
              <div>
                <h3 className="text-sm font-semibold">
                  {metricConfig.label}-Verlauf & Spike-Analyse
                </h3>
                <p
                  className="text-[11px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  Fahre über die Kurve oder klicke auf einen Punkt, um die
                  damaligen Top-Prozesse zu sehen.
                </p>
              </div>
            </div>
            <div
              className="text-2xl font-bold tabular-nums"
              style={{ color: metricConfig.color }}
            >
              {metricConfig.current}
            </div>
          </div>

          <InteractiveAreaChart
            data={slicedHistory}
            valueSelector={metricConfig.selector}
            color={metricConfig.color}
            unit={metricConfig.unit}
            maxValue={metricConfig.max}
            selectedIndex={selectedIdx}
            onSelectIndex={setSelectedIdx}
            onHoverIndex={setHoverIdx}
          />

          {/* Detected Spikes Strip */}
          {detectedSpikes.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap pt-1 border-t" style={{ borderColor: "var(--border-subtle)" }}>
              <span
                className="text-[11px] font-semibold flex items-center gap-1"
                style={{ color: "var(--accent-danger)" }}
              >
                <AlertTriangle className="w-3.5 h-3.5" /> Erkannte Spikes:
              </span>
              {detectedSpikes.map(({ idx, point }) => (
                <button
                  key={point.timestampMs}
                  onClick={() => setSelectedIdx(idx)}
                  className="px-2 py-0.5 rounded-md text-[11px] font-medium cursor-pointer transition-all"
                  style={{
                    backgroundColor:
                      selectedIdx === idx
                        ? "var(--accent-danger)"
                        : "var(--accent-danger-soft)",
                    color:
                      selectedIdx === idx ? "#ffffff" : "var(--accent-danger)",
                  }}
                >
                  {formatTimeShort(point.timestampMs)}{" "}
                  {point.spikeReason ? `• ${point.spikeReason}` : ""}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* "Was war das gerade?" Spike-Blame Panel */}
        <div className="fluent-card p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold flex items-center gap-1.5">
                <History className="w-4 h-4" style={{ color: metricConfig.color }} />
                „Was war das gerade?“
              </h3>
              <p
                className="text-[11px] tabular-nums mt-0.5"
                style={{ color: "var(--text-muted)" }}
              >
                {isHistoricalInspection
                  ? `Momentaufnahme um ${formatTimeShort(inspectedPoint.timestampMs)}`
                  : `Live (${formatTimeShort(inspectedPoint.timestampMs)})`}
              </p>
            </div>
            {selectedIdx != null && (
              <button
                onClick={() => setSelectedIdx(null)}
                className="text-[11px] font-semibold hover:underline cursor-pointer"
                style={{ color: "var(--accent-cpu)" }}
              >
                Live
              </button>
            )}
          </div>

          {/* Snapshot mini metrics */}
          <div className="grid grid-cols-3 gap-1.5 text-center tabular-nums">
            <div
              className="p-2 rounded-lg border"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                CPU
              </div>
              <div
                className="text-xs font-bold"
                style={{ color: "var(--accent-cpu)" }}
              >
                {inspectedPoint.cpuPercent.toFixed(0)}%
              </div>
            </div>
            <div
              className="p-2 rounded-lg border"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                RAM
              </div>
              <div
                className="text-xs font-bold"
                style={{ color: "var(--accent-ram)" }}
              >
                {inspectedPoint.ramPercent.toFixed(0)}%
              </div>
            </div>
            <div
              className="p-2 rounded-lg border"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                GPU
              </div>
              <div
                className="text-xs font-bold"
                style={{ color: "var(--accent-gpu)" }}
              >
                {inspectedPoint.gpuPercent.toFixed(0)}%
              </div>
            </div>
          </div>

          {/* Culprits list */}
          <div className="flex flex-col gap-1.5">
            <div
              className="text-[10px] font-semibold uppercase tracking-wider"
              style={{ color: "var(--text-muted)" }}
            >
              {metric === "ram"
                ? "Top RAM-Prozesse zu diesem Zeitpunkt"
                : "Top CPU-Prozesse zu diesem Zeitpunkt"}
            </div>
            {(metric === "ram"
              ? inspectedPoint.topRam
              : inspectedPoint.topCpu
            ).map((bp) => {
              const cat = getCategoryMeta(bp.category);
              return (
                <button
                  key={`${bp.pid}-${bp.name}`}
                  onClick={() => onInspectPid(bp.pid)}
                  className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-xl border text-left hover:bg-[var(--bg-surface-hover)] cursor-pointer transition-colors"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    borderColor: "var(--border-subtle)",
                  }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: cat.color }}
                    />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold truncate">
                        {bp.name}
                      </div>
                      <div
                        className="text-[10px] truncate"
                        style={{ color: "var(--text-muted)" }}
                      >
                        PID {bp.pid}
                        {bp.subtitle ? ` • ${bp.subtitle}` : ""}
                      </div>
                    </div>
                  </div>
                  <div className="text-right shrink-0 tabular-nums">
                    <div
                      className="text-xs font-bold"
                      style={{
                        color:
                          metric === "ram"
                            ? "var(--accent-ram)"
                            : "var(--accent-cpu)",
                      }}
                    >
                      {metric === "ram"
                        ? formatBytes(bp.memoryBytes)
                        : `${bp.cpuPercent.toFixed(1)}%`}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Hardware Deep-Dive Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Per-Core Detailed Grid */}
        <div className="fluent-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold">
              Logische CPU-Kerne ({snapshot.cpu.logicalCores})
            </h4>
            <span
              className="text-xs tabular-nums"
              style={{ color: "var(--text-muted)" }}
            >
              {(snapshot.cpu.frequencyMhz / 1000).toFixed(2)} GHz
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {snapshot.cpu.perCore.map((val, idx) => (
              <div
                key={idx}
                className="p-2 rounded-xl border"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <div className="flex items-center justify-between text-[11px] tabular-nums mb-1">
                  <span style={{ color: "var(--text-muted)" }}>Kern {idx}</span>
                  <span className="font-semibold">{val.toFixed(0)}%</span>
                </div>
                <div
                  className="h-1.5 rounded-full overflow-hidden"
                  style={{ backgroundColor: "var(--bg-surface-solid)" }}
                >
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: `${Math.max(3, val)}%`,
                      backgroundColor:
                        val > 80
                          ? "#ef4444"
                          : val > 55
                            ? "#f97316"
                            : "var(--accent-cpu)",
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Hardware Specs & Sensors */}
        <div className="fluent-card p-4 flex flex-col gap-3">
          <h4 className="text-sm font-semibold">Hardware & Sensoren</h4>
          <div className="grid grid-cols-2 gap-2.5 text-xs">
            <div
              className="p-3 rounded-xl border"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <div
                className="text-[11px] mb-1"
                style={{ color: "var(--text-muted)" }}
              >
                Prozessor
              </div>
              <div className="font-semibold truncate" title={snapshot.cpu.brand}>
                {snapshot.cpu.brand}
              </div>
              <div
                className="text-[11px] mt-1 tabular-nums"
                style={{ color: "var(--text-secondary)" }}
              >
                {snapshot.cpu.physicalCores} Kerne / {snapshot.cpu.logicalCores}{" "}
                Threads
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
                className="text-[11px] mb-1"
                style={{ color: "var(--text-muted)" }}
              >
                Grafikkarte
              </div>
              <div className="font-semibold truncate" title={snapshot.gpu.name}>
                {snapshot.gpu.name}
              </div>
              <div
                className="text-[11px] mt-1 flex items-center gap-2 tabular-nums"
                style={{ color: "var(--text-secondary)" }}
              >
                {snapshot.gpu.temperatureC != null && (
                  <span className="inline-flex items-center gap-0.5 text-emerald-500 font-medium">
                    <Thermometer className="w-3 h-3" />
                    {snapshot.gpu.temperatureC.toFixed(0)}°C
                  </span>
                )}
                {snapshot.gpu.powerWatts != null && (
                  <span className="inline-flex items-center gap-0.5 text-amber-500 font-medium">
                    <Zap className="w-3 h-3" />
                    {snapshot.gpu.powerWatts.toFixed(1)}W
                  </span>
                )}
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
                className="text-[11px] mb-1"
                style={{ color: "var(--text-muted)" }}
              >
                Arbeitsspeicher
              </div>
              <div className="font-semibold tabular-nums">
                {formatBytes(snapshot.memory.usedBytes)} /{" "}
                {formatBytes(snapshot.memory.totalBytes)}
              </div>
              <div
                className="text-[11px] mt-1 tabular-nums"
                style={{ color: "var(--text-secondary)" }}
              >
                Swap: {formatBytes(snapshot.memory.swapUsedBytes)}
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
                className="text-[11px] mb-1"
                style={{ color: "var(--text-muted)" }}
              >
                Betriebssystem
              </div>
              <div className="font-semibold truncate">
                {snapshot.system.osName}
              </div>
              <div
                className="text-[11px] mt-1 truncate"
                style={{ color: "var(--text-secondary)" }}
              >
                Host: {snapshot.system.hostname}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
