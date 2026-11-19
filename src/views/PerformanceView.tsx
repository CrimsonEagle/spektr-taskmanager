import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Cpu,
  Gpu,
  HardDrive,
  History,
  Info,
  MemoryStick,
  Thermometer,
  Wifi,
  X,
  Zap,
} from "lucide-react";
import { InteractiveAreaChart } from "../components/charts/InteractiveAreaChart";
import {
  formatBytes,
  formatSpeed,
  formatTimeShort,
  getCategoryMeta,
} from "../lib/format";
import {
  BlameProcess,
  HistoryPoint,
  ProcessCategory,
  TelemetrySnapshot,
  TimeRange,
} from "../types/telemetry";

interface PerformanceViewProps {
  snapshot: TelemetrySnapshot;
  history: HistoryPoint[];
  initialSpikeTimestamp?: number | null;
  onClearInitialSpike?: () => void;
  onInspectPid: (pid: number) => void;
}

type MetricKey = "cpu" | "ram" | "gpu" | "disk" | "net";
type TimeWindow = 60 | 300 | 900;

interface AggregatedProcess {
  key: string;
  pid: number;
  name: string;
  subtitle: string;
  category: ProcessCategory;
  avgCpu: number;
  maxCpu: number;
  avgGpu: number;
  maxGpu: number;
  avgRamBytes: number;
  maxRamBytes: number;
  avgDiskBytes: number;
  maxDiskBytes: number;
  avgNetConns: number;
  maxNetConns: number;
  maxNetPorts: number;
  samples: number;
}

export const PerformanceView: React.FC<PerformanceViewProps> = ({
  snapshot,
  history,
  initialSpikeTimestamp,
  onClearInitialSpike,
  onInspectPid,
}) => {
  const [metric, setMetric] = useState<MetricKey>("cpu");
  const [windowSec, setWindowSec] = useState<TimeWindow>(300);
  const [selectedRange, setSelectedRange] = useState<TimeRange | null>(null);
  const [hoverPoint, setHoverPoint] = useState<HistoryPoint | null>(null);

  const slicedHistory = useMemo(
    () => history.slice(-windowSec),
    [history, windowSec]
  );

  // Jump from Overview spike alert -> select a smart ±2.5s window around that spike
  useEffect(() => {
    if (!initialSpikeTimestamp || slicedHistory.length === 0) return;
    const minTs = slicedHistory[0].timestampMs;
    const maxTs = slicedHistory[slicedHistory.length - 1].timestampMs;
    setSelectedRange({
      startMs: Math.max(minTs, initialSpikeTimestamp - 2500),
      endMs: Math.min(maxTs, initialSpikeTimestamp + 2500),
    });
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
      listTitleSingle: "Top CPU-Prozesse zu diesem Zeitpunkt",
      listTitleRange: "Top CPU-Prozesse im Zeitraum",
      emptyText: "Keine messbare CPU-Aktivität in diesem Zeitraum.",
    },
    ram: {
      label: "RAM",
      color: "var(--accent-ram)",
      unit: "%",
      max: 100 as number | undefined,
      selector: (p: HistoryPoint) => p.ramPercent,
      current: `${snapshot.memory.usagePercent.toFixed(1)}%`,
      icon: <MemoryStick className="w-4 h-4" />,
      listTitleSingle: "Top RAM-Prozesse zu diesem Zeitpunkt",
      listTitleRange: "Top RAM-Prozesse im Zeitraum",
      emptyText: "Keine RAM-Prozessdaten verfügbar.",
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
      listTitleSingle: "Top GPU-Prozesse zu diesem Zeitpunkt",
      listTitleRange: "Top GPU-Prozesse im Zeitraum",
      emptyText: "Keine aktive GPU-Engine-Auslastung gemessen.",
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
      listTitleSingle: "Top Datenträger-Prozesse zu diesem Zeitpunkt",
      listTitleRange: "Top Datenträger-Prozesse im Zeitraum",
      emptyText: "Keine aktive Datenträger-Aktivität in diesem Zeitraum.",
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
      listTitleSingle: "Aktivste Netzwerk-Prozesse (Verbindungen)",
      listTitleRange: "Aktivste Netzwerk-Prozesse im Zeitraum",
      emptyText: "Keine aktiven Netzwerk-Verbindungen gefunden.",
    },
  }[metric];

  const activePoints = useMemo<HistoryPoint[]>(() => {
    if (selectedRange) {
      const inRange = slicedHistory.filter(
        (pt) =>
          pt.timestampMs >= selectedRange.startMs &&
          pt.timestampMs <= selectedRange.endMs
      );
      if (inRange.length > 0) return inRange;
    }
    if (hoverPoint) return [hoverPoint];
    return [snapshot.latestPoint];
  }, [selectedRange, slicedHistory, hoverPoint, snapshot.latestPoint]);

  const isRangeMode = activePoints.length > 1;
  const isPinned = selectedRange !== null;

  const analytics = useMemo(() => {
    const n = activePoints.length;
    const sumCpu = activePoints.reduce((s, p) => s + p.cpuPercent, 0);
    const maxCpu = Math.max(...activePoints.map((p) => p.cpuPercent));
    const sumRam = activePoints.reduce((s, p) => s + p.ramPercent, 0);
    const maxRam = Math.max(...activePoints.map((p) => p.ramPercent));
    const sumGpu = activePoints.reduce((s, p) => s + p.gpuPercent, 0);
    const maxGpu = Math.max(...activePoints.map((p) => p.gpuPercent));
    const sumDisk = activePoints.reduce((s, p) => s + p.diskMbPerSec, 0);
    const maxDisk = Math.max(...activePoints.map((p) => p.diskMbPerSec));
    const sumNet = activePoints.reduce((s, p) => s + p.netKbPerSec, 0);
    const maxNet = Math.max(...activePoints.map((p) => p.netKbPerSec));
    const sumUnacc = activePoints.reduce(
      (s, p) => s + (p.unaccountedCpuPercent ?? 0),
      0
    );
    const maxUnacc = Math.max(
      ...activePoints.map((p) => p.unaccountedCpuPercent ?? 0)
    );

    const pickSource = (pt: HistoryPoint): BlameProcess[] => {
      switch (metric) {
        case "ram":
          return pt.topRam ?? [];
        case "gpu":
          return pt.topGpu ?? [];
        case "disk":
          return pt.topDisk ?? [];
        case "net":
          return pt.topNet ?? [];
        default:
          return pt.topCpu ?? [];
      }
    };

    const procMap = new Map<
      string,
      {
        pid: number;
        name: string;
        subtitle: string;
        category: ProcessCategory;
        cpuSum: number;
        cpuMax: number;
        gpuSum: number;
        gpuMax: number;
        ramSum: number;
        ramMax: number;
        diskSum: number;
        diskMax: number;
        netConnSum: number;
        netConnMax: number;
        netPortsMax: number;
        seenCount: number;
      }
    >();

    for (const pt of activePoints) {
      for (const bp of pickSource(pt)) {
        const key = `${bp.pid}::${bp.name}`;
        const existing = procMap.get(key);
        const gpu = bp.gpuPercent ?? 0;
        const disk = bp.diskBytesPerSec ?? 0;
        const netC = bp.netConnections ?? 0;
        const netP = bp.netListeningPorts ?? 0;

        if (existing) {
          existing.cpuSum += bp.cpuPercent;
          existing.cpuMax = Math.max(existing.cpuMax, bp.cpuPercent);
          existing.gpuSum += gpu;
          existing.gpuMax = Math.max(existing.gpuMax, gpu);
          existing.ramSum += bp.memoryBytes;
          existing.ramMax = Math.max(existing.ramMax, bp.memoryBytes);
          existing.diskSum += disk;
          existing.diskMax = Math.max(existing.diskMax, disk);
          existing.netConnSum += netC;
          existing.netConnMax = Math.max(existing.netConnMax, netC);
          existing.netPortsMax = Math.max(existing.netPortsMax, netP);
          existing.seenCount += 1;
          if (!existing.subtitle && bp.subtitle) existing.subtitle = bp.subtitle;
        } else {
          procMap.set(key, {
            pid: bp.pid,
            name: bp.name,
            subtitle: bp.subtitle,
            category: bp.category,
            cpuSum: bp.cpuPercent,
            cpuMax: bp.cpuPercent,
            gpuSum: gpu,
            gpuMax: gpu,
            ramSum: bp.memoryBytes,
            ramMax: bp.memoryBytes,
            diskSum: disk,
            diskMax: disk,
            netConnSum: netC,
            netConnMax: netC,
            netPortsMax: netP,
            seenCount: 1,
          });
        }
      }
    }

    const aggregated: AggregatedProcess[] = Array.from(procMap.entries()).map(
      ([key, v]) => ({
        key,
        pid: v.pid,
        name: v.name,
        subtitle: v.subtitle,
        category: v.category,
        avgCpu: v.cpuSum / n,
        maxCpu: v.cpuMax,
        avgGpu: v.gpuSum / n,
        maxGpu: v.gpuMax,
        avgRamBytes: v.ramSum / v.seenCount,
        maxRamBytes: v.ramMax,
        avgDiskBytes: v.diskSum / n,
        maxDiskBytes: v.diskMax,
        avgNetConns: v.netConnSum / n,
        maxNetConns: v.netConnMax,
        maxNetPorts: v.netPortsMax,
        samples: v.seenCount,
      })
    );

    switch (metric) {
      case "ram":
        aggregated.sort(
          (a, b) => b.avgRamBytes - a.avgRamBytes || b.maxRamBytes - a.maxRamBytes
        );
        break;
      case "gpu":
        aggregated.sort((a, b) => b.avgGpu - a.avgGpu || b.maxGpu - a.maxGpu);
        break;
      case "disk":
        aggregated.sort(
          (a, b) =>
            b.avgDiskBytes - a.avgDiskBytes || b.maxDiskBytes - a.maxDiskBytes
        );
        break;
      case "net":
        aggregated.sort(
          (a, b) =>
            b.avgNetConns - a.avgNetConns ||
            b.maxNetConns - a.maxNetConns ||
            b.maxNetPorts - a.maxNetPorts
        );
        break;
      default:
        aggregated.sort((a, b) => b.avgCpu - a.avgCpu || b.maxCpu - a.maxCpu);
        break;
    }

    return {
      count: n,
      startMs: activePoints[0].timestampMs,
      endMs: activePoints[n - 1].timestampMs,
      avgCpu: sumCpu / n,
      maxCpu,
      avgRam: sumRam / n,
      maxRam,
      avgGpu: sumGpu / n,
      maxGpu,
      avgDisk: sumDisk / n,
      maxDisk,
      avgNet: sumNet / n,
      maxNet,
      avgUnaccounted: sumUnacc / n,
      maxUnaccounted: maxUnacc,
      topProcesses: aggregated.slice(0, 6),
    };
  }, [activePoints, metric]);

  const detectedSpikes = useMemo(() => {
    const out: HistoryPoint[] = [];
    for (const pt of slicedHistory) {
      if (pt.isSpike) out.push(pt);
    }
    return out.slice(-6).reverse();
  }, [slicedHistory]);

  const selectSpikeWindow = (ts: number) => {
    if (slicedHistory.length === 0) return;
    const minTs = slicedHistory[0].timestampMs;
    const maxTs = slicedHistory[slicedHistory.length - 1].timestampMs;
    setSelectedRange({
      startMs: Math.max(minTs, ts - 2500),
      endMs: Math.min(maxTs, ts + 2500),
    });
  };

  // Fixed-width metric filter tabs so values updating every second NEVER shift or flicker!
  const filterTabs = [
    {
      id: "cpu" as const,
      label: "CPU",
      val: `${snapshot.cpu.totalUsage.toFixed(0)}%`,
      color: "var(--accent-cpu)",
      widthClass: "w-[106px]",
    },
    {
      id: "ram" as const,
      label: "RAM",
      val: `${snapshot.memory.usagePercent.toFixed(0)}%`,
      color: "var(--accent-ram)",
      widthClass: "w-[108px]",
    },
    {
      id: "gpu" as const,
      label: "GPU",
      val:
        snapshot.gpu.usagePercent != null
          ? `${snapshot.gpu.usagePercent.toFixed(0)}%`
          : "–",
      color: "var(--accent-gpu)",
      widthClass: "w-[106px]",
    },
    {
      id: "disk" as const,
      label: "Disk",
      val: formatSpeed(
        snapshot.disk.readBytesPerSec + snapshot.disk.writeBytesPerSec
      ),
      color: "var(--accent-disk)",
      widthClass: "w-[144px]",
    },
    {
      id: "net" as const,
      label: "Netz",
      val: formatSpeed(
        snapshot.network.rxBytesPerSec + snapshot.network.txBytesPerSec
      ),
      color: "var(--accent-net)",
      widthClass: "w-[146px]",
    },
  ];

  const maxNetConnsInList = Math.max(
    1,
    ...analytics.topProcesses.map((p) => p.maxNetConns || p.maxNetPorts)
  );
  const maxDiskInList = Math.max(
    1024,
    ...analytics.topProcesses.map((p) => p.maxDiskBytes)
  );

  return (
    <div className="flex flex-col gap-4 pb-6">
      {/* Top Bar: Fixed-width Resource Selector + Time Window */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          {filterTabs.map((tab) => {
            const active = metric === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setMetric(tab.id)}
                className={`${tab.widthClass} shrink-0 px-3 py-2 rounded-xl border text-xs font-semibold flex items-center justify-between gap-1.5 transition-colors cursor-pointer tabular-nums`}
                style={{
                  backgroundColor: active
                    ? "var(--bg-surface-solid)"
                    : "var(--bg-surface)",
                  borderColor: active ? tab.color : "var(--border-subtle)",
                  color: active ? tab.color : "var(--text-secondary)",
                  boxShadow: active ? "var(--shadow-card)" : "none",
                }}
              >
                <span className="flex items-center gap-1.5 shrink-0">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: tab.color }}
                  />
                  <span>{tab.label}</span>
                </span>
                <span className="opacity-85 text-right truncate">{tab.val}</span>
              </button>
            );
          })}
        </div>

        {/* Time Window */}
        <div
          className="flex items-center p-1 rounded-xl border gap-0.5 text-xs shrink-0"
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
                setSelectedRange(null);
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

      {/* Main Chart + Range/Spike Analytics Panel */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_365px] gap-4">
        <div className="fluent-card p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span style={{ color: metricConfig.color }}>
                {metricConfig.icon}
              </span>
              <div>
                <h3 className="text-sm font-semibold">
                  {metricConfig.label}-Verlauf & Bereichs-Analyse
                </h3>
                <p
                  className="text-[11px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  Ziehe mit gedrückter Maustaste einen Bereich auf (oder klicke
                  einen Punkt), um diesen Zeitraum auszuwerten.
                </p>
              </div>
            </div>
            <div
              className="text-2xl font-bold tabular-nums shrink-0"
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
            selectedRange={selectedRange}
            onSelectRange={setSelectedRange}
            onHoverPoint={setHoverPoint}
          />

          {/* Active Selection Info Strip */}
          {isPinned && (
            <div
              className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-xl border text-xs"
              style={{
                backgroundColor: `${metricConfig.color}14`,
                borderColor: `${metricConfig.color}44`,
              }}
            >
              <span className="tabular-nums font-medium">
                {isRangeMode ? (
                  <>
                    Ausgewählter Bereich:{" "}
                    <strong>
                      {formatTimeShort(analytics.startMs)} –{" "}
                      {formatTimeShort(analytics.endMs)}
                    </strong>{" "}
                    ({analytics.count}s)
                  </>
                ) : (
                  <>
                    Fixierter Zeitpunkt:{" "}
                    <strong>{formatTimeShort(analytics.startMs)}</strong>
                  </>
                )}
              </span>
              <button
                onClick={() => setSelectedRange(null)}
                className="flex items-center gap-1 text-[11px] font-semibold cursor-pointer hover:underline"
                style={{ color: metricConfig.color }}
              >
                <X className="w-3.5 h-3.5" />
                Auswahl aufheben
              </button>
            </div>
          )}

          {/* Detected Spikes Strip */}
          {detectedSpikes.length > 0 && (
            <div
              className="flex items-center gap-2 flex-wrap pt-1.5 border-t"
              style={{ borderColor: "var(--border-subtle)" }}
            >
              <span
                className="text-[11px] font-semibold flex items-center gap-1"
                style={{ color: "var(--accent-danger)" }}
              >
                <AlertTriangle className="w-3.5 h-3.5" /> Erkannte Spikes:
              </span>
              {detectedSpikes.map((point) => {
                const isIncluded =
                  selectedRange != null &&
                  point.timestampMs >= selectedRange.startMs &&
                  point.timestampMs <= selectedRange.endMs;
                return (
                  <button
                    key={point.timestampMs}
                    onClick={() => selectSpikeWindow(point.timestampMs)}
                    className="px-2 py-0.5 rounded-md text-[11px] font-medium cursor-pointer transition-colors"
                    style={{
                      backgroundColor: isIncluded
                        ? "var(--accent-danger)"
                        : "var(--accent-danger-soft)",
                      color: isIncluded ? "#ffffff" : "var(--accent-danger)",
                    }}
                  >
                    {formatTimeShort(point.timestampMs)}
                    {point.spikeReason ? ` • ${point.spikeReason}` : ""}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Right Panel: Metric-specific Top Processes & Range Analytics */}
        <div className="fluent-card p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold flex items-center gap-1.5">
                <History className="w-4 h-4" style={{ color: metricConfig.color }} />
                {isRangeMode ? "Bereichs-Auswertung" : "„Was war das gerade?“"}
              </h3>
              <p
                className="text-[11px] tabular-nums mt-0.5"
                style={{ color: "var(--text-muted)" }}
              >
                {isRangeMode
                  ? `${formatTimeShort(analytics.startMs)} – ${formatTimeShort(analytics.endMs)} (${analytics.count}s)`
                  : isPinned
                    ? `Momentaufnahme um ${formatTimeShort(analytics.startMs)}`
                    : hoverPoint
                      ? `Vorschau um ${formatTimeShort(analytics.startMs)}`
                      : `Live (${formatTimeShort(analytics.startMs)})`}
              </p>
            </div>
            {isPinned && (
              <button
                onClick={() => setSelectedRange(null)}
                className="text-[11px] font-semibold hover:underline cursor-pointer shrink-0"
                style={{ color: "var(--accent-cpu)" }}
              >
                Live
              </button>
            )}
          </div>

          {/* Summary Stat Cards */}
          <div className="grid grid-cols-3 gap-1.5 text-center tabular-nums">
            <div
              className="p-2 rounded-lg border"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                CPU {isRangeMode ? "(Ø / Max)" : ""}
              </div>
              <div
                className="text-xs font-bold mt-0.5"
                style={{ color: "var(--accent-cpu)" }}
              >
                {isRangeMode
                  ? `${analytics.avgCpu.toFixed(0)}% / ${analytics.maxCpu.toFixed(0)}%`
                  : `${analytics.avgCpu.toFixed(1)}%`}
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
                RAM {isRangeMode ? "(Ø / Max)" : ""}
              </div>
              <div
                className="text-xs font-bold mt-0.5"
                style={{ color: "var(--accent-ram)" }}
              >
                {isRangeMode
                  ? `${analytics.avgRam.toFixed(0)}% / ${analytics.maxRam.toFixed(0)}%`
                  : `${analytics.avgRam.toFixed(1)}%`}
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
                GPU {isRangeMode ? "(Ø / Max)" : ""}
              </div>
              <div
                className="text-xs font-bold mt-0.5"
                style={{ color: "var(--accent-gpu)" }}
              >
                {isRangeMode
                  ? `${analytics.avgGpu.toFixed(0)}% / ${analytics.maxGpu.toFixed(0)}%`
                  : `${analytics.avgGpu.toFixed(0)}%`}
              </div>
            </div>
          </div>

          {/* Extra Disk / Net range stats when Disk or Net tab is selected */}
          {(metric === "disk" || metric === "net") && (
            <div
              className="px-3 py-2 rounded-lg border text-xs flex items-center justify-between tabular-nums"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <span style={{ color: "var(--text-muted)" }}>
                {metric === "disk"
                  ? isRangeMode
                    ? "Datenträger (Ø / Peak)"
                    : "Datenträger Durchsatz"
                  : isRangeMode
                    ? "Netzwerk (Ø / Peak)"
                    : "Netzwerk Durchsatz"}
              </span>
              <span className="font-bold" style={{ color: metricConfig.color }}>
                {metric === "disk"
                  ? isRangeMode
                    ? `${analytics.avgDisk.toFixed(1)} / ${analytics.maxDisk.toFixed(1)} MB/s`
                    : `${analytics.avgDisk.toFixed(1)} MB/s`
                  : isRangeMode
                    ? `${analytics.avgNet.toFixed(0)} / ${analytics.maxNet.toFixed(0)} KB/s`
                    : `${analytics.avgNet.toFixed(0)} KB/s`}
              </span>
            </div>
          )}

          {/* Metric-Specific Top Processes List */}
          <div className="flex flex-col gap-1.5">
            <div
              className="text-[10px] font-semibold uppercase tracking-wider"
              style={{ color: "var(--text-muted)" }}
            >
              {isRangeMode
                ? metricConfig.listTitleRange
                : metricConfig.listTitleSingle}
            </div>

            {analytics.topProcesses.length === 0 ? (
              <div
                className="p-4 rounded-xl border text-center text-xs"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-subtle)",
                  color: "var(--text-muted)",
                }}
              >
                {metricConfig.emptyText}
              </div>
            ) : (
              analytics.topProcesses.map((bp) => {
                const cat = getCategoryMeta(bp.category);

                let primaryVal = "";
                let secondaryVal = "";
                let barPct = 4;

                if (metric === "ram") {
                  primaryVal = isRangeMode
                    ? `Ø ${formatBytes(bp.avgRamBytes)}`
                    : formatBytes(bp.avgRamBytes);
                  if (isRangeMode && bp.maxRamBytes > bp.avgRamBytes * 1.03) {
                    secondaryVal = `Peak ${formatBytes(bp.maxRamBytes)}`;
                  }
                  barPct = Math.min(
                    100,
                    Math.max(
                      4,
                      (bp.avgRamBytes / Math.max(1, snapshot.memory.totalBytes)) *
                        300
                    )
                  );
                } else if (metric === "gpu") {
                  primaryVal = isRangeMode
                    ? `Ø ${bp.avgGpu.toFixed(1)}%`
                    : `${bp.avgGpu.toFixed(1)}%`;
                  if (isRangeMode) {
                    secondaryVal = `Peak ${bp.maxGpu.toFixed(1)}%`;
                  }
                  barPct = Math.min(
                    100,
                    Math.max(4, (bp.avgGpu / Math.max(10, analytics.maxGpu)) * 100)
                  );
                } else if (metric === "disk") {
                  primaryVal = isRangeMode
                    ? `Ø ${formatSpeed(bp.avgDiskBytes)}`
                    : formatSpeed(bp.avgDiskBytes);
                  if (isRangeMode) {
                    secondaryVal = `Peak ${formatSpeed(bp.maxDiskBytes)}`;
                  }
                  barPct = Math.min(
                    100,
                    Math.max(4, (bp.maxDiskBytes / maxDiskInList) * 100)
                  );
                } else if (metric === "net") {
                  const mainConns = isRangeMode
                    ? Math.round(bp.avgNetConns)
                    : bp.maxNetConns;
                  primaryVal =
                    mainConns > 0
                      ? `${mainConns} aktiv`
                      : `${bp.maxNetPorts} Port${bp.maxNetPorts === 1 ? "" : "s"}`;
                  if (isRangeMode && bp.maxNetConns > mainConns) {
                    secondaryVal = `Peak ${bp.maxNetConns}${bp.maxNetPorts > 0 ? ` · ${bp.maxNetPorts}P` : ""}`;
                  } else if (mainConns > 0 && bp.maxNetPorts > 0) {
                    secondaryVal = `${bp.maxNetPorts} offene Ports`;
                  }
                  barPct = Math.min(
                    100,
                    Math.max(
                      6,
                      ((bp.maxNetConns || bp.maxNetPorts) / maxNetConnsInList) *
                        100
                    )
                  );
                } else {
                  primaryVal = isRangeMode
                    ? `Ø ${bp.avgCpu.toFixed(1)}%`
                    : `${bp.avgCpu.toFixed(1)}%`;
                  if (isRangeMode) {
                    secondaryVal = `Peak ${bp.maxCpu.toFixed(1)}%`;
                  }
                  barPct = Math.min(
                    100,
                    Math.max(4, (bp.avgCpu / Math.max(10, analytics.maxCpu)) * 100)
                  );
                }

                return (
                  <button
                    key={bp.key}
                    onClick={() => onInspectPid(bp.pid)}
                    className="flex flex-col gap-1 px-2.5 py-2 rounded-xl border text-left hover:bg-[var(--bg-surface-hover)] cursor-pointer transition-colors"
                    style={{
                      backgroundColor: "var(--bg-subtle)",
                      borderColor: "var(--border-subtle)",
                    }}
                  >
                    <div className="flex items-center justify-between gap-2 w-full">
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
                          style={{ color: metricConfig.color }}
                        >
                          {primaryVal}
                        </div>
                        {secondaryVal && (
                          <div
                            className="text-[10px]"
                            style={{ color: "var(--text-muted)" }}
                          >
                            {secondaryVal}
                          </div>
                        )}
                      </div>
                    </div>

                    <div
                      className="h-1 w-full rounded-full overflow-hidden"
                      style={{ backgroundColor: "var(--bg-surface-solid)" }}
                    >
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${barPct}%`,
                          backgroundColor: metricConfig.color,
                        }}
                      />
                    </div>
                  </button>
                );
              })
            )}

            {/* Residual CPU note ONLY on CPU tab */}
            {metric === "cpu" &&
              (analytics.avgUnaccounted >= 4 ||
                analytics.maxUnaccounted >= 12) && (
                <div
                  className="px-2.5 py-2 rounded-xl border text-[11px] flex items-center justify-between gap-2"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    borderColor: "var(--border-subtle)",
                    color: "var(--text-secondary)",
                  }}
                  title="CPU-Last durch Prozesse, die innerhalb derselben Sekunde gestartet und wieder beendet wurden, oder durch Hardware-Interrupts/DPCs."
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <Info className="w-3.5 h-3.5 shrink-0 opacity-70" />
                    <span className="truncate">
                      Kurzlebige Prozesse / Kernel-Interrupts
                    </span>
                  </span>
                  <span className="font-semibold tabular-nums shrink-0">
                    {isRangeMode
                      ? `Ø ${analytics.avgUnaccounted.toFixed(1)}% · Peak ${analytics.maxUnaccounted.toFixed(0)}%`
                      : `${analytics.avgUnaccounted.toFixed(1)}%`}
                  </span>
                </div>
              )}
          </div>
        </div>
      </div>

      {/* Hardware Deep-Dive Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
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
