import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsDownUp as ArrowUpDown,
  ClockCounterClockwise as History,
  Cpu,
  DownloadSimple as Download,
  Fan,
  Gauge,
  GraphicsCard as Gpu,
  HardDrives as HardDrive,
  Info,
  Lightning as Zap,
  Memory as MemoryStick,
  Shield,
  Thermometer,
  Warning as AlertTriangle,
  WifiHigh as Wifi,
  X,
} from "@phosphor-icons/react";
import { InteractiveAreaChart } from "../components/charts/InteractiveAreaChart";
import { Sparkline } from "../components/charts/Sparkline";
import {
  formatBytes,
  formatSpeed,
  formatTimeShort,
  getCategoryMeta,
} from "../lib/format";
import { api } from "../lib/tauri";
import {
  ActionResult,
  BlameProcess,
  HistoryPoint,
  PerformanceMetric,
  ProcessCategory,
  TelemetrySnapshot,
  TimeRange,
} from "../types/telemetry";

interface PerformanceViewProps {
  snapshot: TelemetrySnapshot;
  history: HistoryPoint[];
  activeMetric?: PerformanceMetric;
  onMetricChange?: (metric: PerformanceMetric) => void;
  initialSpikeTimestamp?: number | null;
  onClearInitialSpike?: () => void;
  onInspectPid: (pid: number, fallback?: BlameProcess) => void;
  onRestartAsAdmin?: () => void;
  onActionFeedback?: (res: ActionResult) => void;
}

type MetricKey = "cpu" | "ram" | "gpu" | "disk" | "net";
type TimeWindow = 60 | 300 | 900;
type GpuSeriesKey = "overall" | "3d" | "copy" | "encode" | "decode";

const GPU_SERIES_META: Record<
  GpuSeriesKey,
  {
    label: string;
    shortLabel: string;
    chartTitle: string;
    selector: (p: HistoryPoint) => number;
  }
> = {
  overall: {
    label: "GPU Gesamt",
    shortLabel: "GPU",
    chartTitle: "GPU",
    selector: (p) => p.gpuPercent,
  },
  "3d": {
    label: "3D",
    shortLabel: "3D",
    chartTitle: "GPU · 3D",
    selector: (p) => p.gpuEngine3d ?? 0,
  },
  copy: {
    label: "Copy",
    shortLabel: "Copy",
    chartTitle: "GPU · Copy",
    selector: (p) => p.gpuEngineCopy ?? 0,
  },
  encode: {
    label: "Video Encode",
    shortLabel: "Encode",
    chartTitle: "GPU · Video Encode",
    selector: (p) => p.gpuEngineEncode ?? 0,
  },
  decode: {
    label: "Video Decode",
    shortLabel: "Decode",
    chartTitle: "GPU · Video Decode",
    selector: (p) => p.gpuEngineDecode ?? 0,
  },
};

function perfToMetricKey(m: PerformanceMetric): MetricKey {
  if (m === "memory") return "ram";
  if (m === "network") return "net";
  return m;
}

function metricKeyToPerf(k: MetricKey): PerformanceMetric {
  if (k === "ram") return "memory";
  if (k === "net") return "network";
  return k;
}

// Stable valueSelector functions outside the component so InteractiveAreaChart's useMemo
// is NOT invalidated on every mousemove/hover re-render!
const METRIC_SELECTORS: Record<MetricKey, (p: HistoryPoint) => number> = {
  cpu: (p) => p.cpuPercent,
  ram: (p) => p.ramPercent,
  gpu: (p) => p.gpuPercent,
  disk: (p) => p.diskMbPerSec,
  net: (p) => p.netKbPerSec,
};
const DISK_ACTIVE_SELECTOR = (p: HistoryPoint) => p.diskActivePercent ?? 0;

const METRIC_STATIC_META: Record<
  MetricKey,
  {
    label: string;
    color: string;
    unit: string;
    max: number | undefined;
    listTitleSingle: string;
    listTitleRange: string;
    emptyText: string;
  }
> = {
  cpu: {
    label: "CPU",
    color: "var(--accent-cpu)",
    unit: "%",
    max: 100,
    listTitleSingle: "Top CPU-Prozesse",
    listTitleRange: "Top CPU-Prozesse (Zeitraum)",
    emptyText: "Keine messbare CPU-Aktivität in diesem Zeitraum.",
  },
  ram: {
    label: "RAM",
    color: "var(--accent-ram)",
    unit: "%",
    max: 100,
    listTitleSingle: "Top RAM-Prozesse",
    listTitleRange: "Top RAM-Prozesse (Zeitraum)",
    emptyText: "Keine RAM-Prozessdaten verfügbar.",
  },
  gpu: {
    label: "GPU",
    color: "var(--accent-gpu)",
    unit: "%",
    max: 100,
    listTitleSingle: "Top GPU-Prozesse",
    listTitleRange: "Top GPU-Prozesse (Zeitraum)",
    emptyText: "Keine aktive GPU-Engine-Auslastung gemessen.",
  },
  disk: {
    label: "Disk I/O",
    color: "var(--accent-disk)",
    unit: "MB/s",
    max: undefined,
    listTitleSingle: "Top Disk-Prozesse",
    listTitleRange: "Top Disk-Prozesse (Zeitraum)",
    emptyText: "Keine aktive Datenträger-Aktivität in diesem Zeitraum.",
  },
  net: {
    label: "Netzwerk",
    color: "var(--accent-net)",
    unit: "KB/s",
    max: undefined,
    listTitleSingle: "Top Netzwerk-Prozesse",
    listTitleRange: "Top Netzwerk-Prozesse (Zeitraum)",
    emptyText: "Kein messbarer Netzwerk-Durchsatz in diesem Zeitraum.",
  },
};

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
  avgNetBytes: number;
  maxNetBytes: number;
  avgNetRxBytes: number;
  avgNetTxBytes: number;
  avgNetConns: number;
  maxNetConns: number;
  maxNetPorts: number;
  samples: number;
}

export const PerformanceView: React.FC<PerformanceViewProps> = React.memo(({
  snapshot,
  history,
  activeMetric,
  onMetricChange,
  initialSpikeTimestamp,
  onClearInitialSpike,
  onInspectPid,
  onRestartAsAdmin,
  onActionFeedback,
}) => {
  const [internalMetric, setInternalMetric] = useState<MetricKey>("cpu");
  const metric: MetricKey = activeMetric
    ? perfToMetricKey(activeMetric)
    : internalMetric;

  const selectMetric = (next: MetricKey) => {
    setInternalMetric(next);
    onMetricChange?.(metricKeyToPerf(next));
  };

  const [windowSec, setWindowSec] = useState<TimeWindow>(300);
  const [diskChartMode, setDiskChartMode] = useState<"active" | "throughput">(
    "active"
  );
  const [activeGpuSeries, setActiveGpuSeries] =
    useState<GpuSeriesKey>("overall");
  const [gpuBottomSlots, setGpuBottomSlots] = useState<GpuSeriesKey[]>([
    "3d",
    "copy",
    "encode",
    "decode",
  ]);
  const [selectedRange, setSelectedRange] = useState<TimeRange | null>(null);
  const [hoverPoint, setHoverPoint] = useState<HistoryPoint | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [showAllProcesses, setShowAllProcesses] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  const handleSwapGpuSeries = (slotIndex: number) => {
    const clicked = gpuBottomSlots[slotIndex];
    if (!clicked) return;
    const prevActive = activeGpuSeries;
    setActiveGpuSeries(clicked);
    setGpuBottomSlots((prev) =>
      prev.map((key, idx) => (idx === slotIndex ? prevActive : key))
    );
  };

  const handleResetGpuSeries = () => {
    setActiveGpuSeries("overall");
    setGpuBottomSlots(["3d", "copy", "encode", "decode"]);
  };

  useEffect(() => {
    if (!exportMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        exportMenuRef.current &&
        !exportMenuRef.current.contains(e.target as Node)
      ) {
        setExportMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExportMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [exportMenuOpen]);

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

  const staticMeta = METRIC_STATIC_META[metric];
  const isDiskActiveChart = metric === "disk" && diskChartMode === "active";
  const activeGpuMeta = GPU_SERIES_META[activeGpuSeries];
  const valueSelector = isDiskActiveChart
    ? DISK_ACTIVE_SELECTOR
    : metric === "gpu"
      ? activeGpuMeta.selector
      : METRIC_SELECTORS[metric];

  const getLiveGpuSeriesVal = (key: GpuSeriesKey): number | null => {
    switch (key) {
      case "overall":
        return snapshot.gpu.usagePercent;
      case "3d":
        return snapshot.gpu.engine3dPercent ?? 0;
      case "copy":
        return snapshot.gpu.engineCopyPercent ?? 0;
      case "encode":
        return snapshot.gpu.engineVideoEncodePercent ?? 0;
      case "decode":
        return snapshot.gpu.engineVideoDecodePercent ?? 0;
    }
  };

  const activeGpuLiveVal = getLiveGpuSeriesVal(activeGpuSeries);

  const currentMetricText =
    metric === "cpu"
      ? `${snapshot.cpu.totalUsage.toFixed(1)}%`
      : metric === "ram"
        ? `${snapshot.memory.usagePercent.toFixed(1)}%`
        : metric === "gpu"
          ? activeGpuLiveVal != null
            ? `${activeGpuLiveVal.toFixed(0)}%`
            : "–"
          : metric === "disk"
            ? isDiskActiveChart
              ? `${(snapshot.disk.activePercent ?? 0).toFixed(0)}%`
              : formatSpeed(
                  snapshot.disk.readBytesPerSec + snapshot.disk.writeBytesPerSec
                )
            : formatSpeed(
                snapshot.network.rxBytesPerSec + snapshot.network.txBytesPerSec
              );

  const metricIcon =
    metric === "cpu" ? (
      <Cpu className="w-4 h-4" />
    ) : metric === "ram" ? (
      <MemoryStick className="w-4 h-4" />
    ) : metric === "gpu" ? (
      <Gpu className="w-4 h-4" />
    ) : metric === "disk" ? (
      <HardDrive className="w-4 h-4" />
    ) : (
      <Wifi className="w-4 h-4" />
    );

  const metricConfig = {
    ...staticMeta,
    label: metric === "gpu" ? activeGpuMeta.chartTitle : staticMeta.label,
    unit: isDiskActiveChart ? "%" : staticMeta.unit,
    max: isDiskActiveChart ? 100 : staticMeta.max,
    selector: valueSelector,
    current: currentMetricText,
    icon: metricIcon,
  };

  // 60-sample mini-history for GPU engine Sparklines (including overall for swap slots)
  const gpuEngineSeries = useMemo<Record<GpuSeriesKey, number[]>>(() => {
    const recent = history.slice(-60);
    return {
      overall: recent.map((h) => h.gpuPercent),
      "3d": recent.map((h) => h.gpuEngine3d ?? 0),
      copy: recent.map((h) => h.gpuEngineCopy ?? 0),
      encode: recent.map((h) => h.gpuEngineEncode ?? 0),
      decode: recent.map((h) => h.gpuEngineDecode ?? 0),
    };
  }, [history]);

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
    let sumCpu = 0;
    let maxCpu = 0;
    let sumRam = 0;
    let maxRam = 0;
    let sumGpu = 0;
    let maxGpu = 0;
    let sumGpuSelected = 0;
    let maxGpuSelected = 0;
    let sumGpu3d = 0;
    let sumGpuCopy = 0;
    let sumGpuEncode = 0;
    let sumGpuDecode = 0;
    let sumDisk = 0;
    let maxDisk = 0;
    let sumNet = 0;
    let maxNet = 0;
    let sumUnacc = 0;
    let maxUnacc = 0;

    const gpuSelectedSelector = GPU_SERIES_META[activeGpuSeries].selector;

    for (let i = 0; i < n; i++) {
      const p = activePoints[i];
      sumCpu += p.cpuPercent;
      if (p.cpuPercent > maxCpu) maxCpu = p.cpuPercent;
      sumRam += p.ramPercent;
      if (p.ramPercent > maxRam) maxRam = p.ramPercent;
      sumGpu += p.gpuPercent;
      if (p.gpuPercent > maxGpu) maxGpu = p.gpuPercent;
      const gSel = gpuSelectedSelector(p);
      sumGpuSelected += gSel;
      if (gSel > maxGpuSelected) maxGpuSelected = gSel;
      sumGpu3d += p.gpuEngine3d ?? 0;
      sumGpuCopy += p.gpuEngineCopy ?? 0;
      sumGpuEncode += p.gpuEngineEncode ?? 0;
      sumGpuDecode += p.gpuEngineDecode ?? 0;
      sumDisk += p.diskMbPerSec;
      if (p.diskMbPerSec > maxDisk) maxDisk = p.diskMbPerSec;
      sumNet += p.netKbPerSec;
      if (p.netKbPerSec > maxNet) maxNet = p.netKbPerSec;
      const unacc = p.unaccountedCpuPercent ?? 0;
      sumUnacc += unacc;
      if (unacc > maxUnacc) maxUnacc = unacc;
    }

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
        netSum: number;
        netMax: number;
        netRxSum: number;
        netTxSum: number;
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
        const netRx = bp.netRxBytesPerSec ?? 0;
        const netTx = bp.netTxBytesPerSec ?? 0;
        const netTot = netRx + netTx;
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
          existing.netSum += netTot;
          existing.netMax = Math.max(existing.netMax, netTot);
          existing.netRxSum += netRx;
          existing.netTxSum += netTx;
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
            netSum: netTot,
            netMax: netTot,
            netRxSum: netRx,
            netTxSum: netTx,
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
        avgNetBytes: v.netSum / n,
        maxNetBytes: v.netMax,
        avgNetRxBytes: v.netRxSum / n,
        avgNetTxBytes: v.netTxSum / n,
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
            b.avgNetBytes - a.avgNetBytes || b.maxNetBytes - a.maxNetBytes
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
      avgGpuSelected: sumGpuSelected / n,
      maxGpuSelected,
      avgGpu3d: sumGpu3d / n,
      avgGpuCopy: sumGpuCopy / n,
      avgGpuEncode: sumGpuEncode / n,
      avgGpuDecode: sumGpuDecode / n,
      avgDisk: sumDisk / n,
      maxDisk,
      avgNet: sumNet / n,
      maxNet,
      avgUnaccounted: sumUnacc / n,
      maxUnaccounted: maxUnacc,
      topProcesses: aggregated.slice(0, 5),
      allProcesses: aggregated,
    };
  }, [activePoints, metric, activeGpuSeries]);

  const isLiveMode = !isPinned && !hoverPoint;

  // Expandable process list: in Live mode up to 30 live processes from snapshot.processes;
  // in History/Range mode all unique aggregated BlameProcesses from the selected window.
  const { displayedProcesses, totalAvailableProcesses } = useMemo(() => {
    if (isLiveMode && snapshot.processes.length > 0) {
      const liveAgg: AggregatedProcess[] = snapshot.processes.map((p) => {
        const netRx = p.netRxBytesPerSec ?? 0;
        const netTx = p.netTxBytesPerSec ?? 0;
        const netTot = netRx + netTx;
        return {
          key: `${p.pid}::${p.name}`,
          pid: p.pid,
          name: p.name,
          subtitle: p.subtitle,
          category: p.category,
          avgCpu: p.cpuPercent,
          maxCpu: p.cpuPercent,
          avgGpu: p.gpuPercent,
          maxGpu: p.gpuPercent,
          avgRamBytes: p.memoryBytes,
          maxRamBytes: p.memoryBytes,
          avgDiskBytes: p.diskReadBytesPerSec + p.diskWriteBytesPerSec,
          maxDiskBytes: p.diskReadBytesPerSec + p.diskWriteBytesPerSec,
          avgNetBytes: netTot,
          maxNetBytes: netTot,
          avgNetRxBytes: netRx,
          avgNetTxBytes: netTx,
          avgNetConns: 0,
          maxNetConns: 0,
          maxNetPorts: 0,
          samples: 1,
        };
      });

      let filtered = liveAgg;
      if (metric === "ram") {
        filtered.sort((a, b) => b.avgRamBytes - a.avgRamBytes);
      } else if (metric === "gpu") {
        filtered.sort((a, b) => b.avgGpu - a.avgGpu);
      } else if (metric === "disk") {
        filtered.sort((a, b) => b.avgDiskBytes - a.avgDiskBytes);
      } else if (metric === "net") {
        filtered = liveAgg
          .filter((p) => p.avgNetBytes > 0)
          .sort((a, b) => b.avgNetBytes - a.avgNetBytes);
      } else {
        filtered.sort((a, b) => b.avgCpu - a.avgCpu);
      }

      const capped = filtered.slice(0, 30);
      return {
        displayedProcesses: showAllProcesses ? capped : capped.slice(0, 5),
        totalAvailableProcesses: capped.length,
      };
    }

    const histAll = analytics.allProcesses;
    return {
      displayedProcesses: showAllProcesses ? histAll : histAll.slice(0, 5),
      totalAvailableProcesses: histAll.length,
    };
  }, [isLiveMode, metric, snapshot.processes, analytics.allProcesses, showAllProcesses]);

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

  const handleExportReport = async (format: "json" | "csv" | "md") => {
    setExportMenuOpen(false);
    const exportPoints =
      selectedRange != null && activePoints.length > 0
        ? activePoints
        : slicedHistory;
    const tsTag = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

    const extMap = {
      json: { ext: "json", name: "JSON-Bericht" },
      csv: { ext: "csv", name: "CSV-Tabelle" },
      md: { ext: "md", name: "Markdown-Bericht" },
    }[format];

    try {
      const path = await api.saveFile(
        `spektr-performance-${metric}-${tsTag}.${extMap.ext}`,
        extMap.name,
        [extMap.ext]
      );
      if (!path) return;

      let content = "";
      if (format === "json") {
        content = JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            host: snapshot.system.hostname,
            os: snapshot.system.osName,
            metric,
            range: {
              startMs: analytics.startMs,
              endMs: analytics.endMs,
              samples: exportPoints.length,
            },
            summary: {
              avgCpu: Number(analytics.avgCpu.toFixed(2)),
              maxCpu: Number(analytics.maxCpu.toFixed(2)),
              avgRam: Number(analytics.avgRam.toFixed(2)),
              maxRam: Number(analytics.maxRam.toFixed(2)),
              avgGpu: Number(analytics.avgGpu.toFixed(2)),
              maxGpu: Number(analytics.maxGpu.toFixed(2)),
              avgDiskMbPerSec: Number(analytics.avgDisk.toFixed(2)),
              maxDiskMbPerSec: Number(analytics.maxDisk.toFixed(2)),
              avgNetKbPerSec: Number(analytics.avgNet.toFixed(2)),
              maxNetKbPerSec: Number(analytics.maxNet.toFixed(2)),
            },
            topProcesses: analytics.topProcesses,
            spikes: exportPoints
              .filter((p) => p.isSpike)
              .map((p) => ({
                timestamp: new Date(p.timestampMs).toISOString(),
                reason: p.spikeReason,
                cpuPercent: p.cpuPercent,
                ramPercent: p.ramPercent,
                gpuPercent: p.gpuPercent,
              })),
            series: exportPoints.map((p) => ({
              timestampMs: p.timestampMs,
              cpuPercent: p.cpuPercent,
              ramPercent: p.ramPercent,
              gpuPercent: p.gpuPercent,
              diskMbPerSec: p.diskMbPerSec,
              netKbPerSec: p.netKbPerSec,
              isSpike: p.isSpike,
              spikeReason: p.spikeReason,
            })),
          },
          null,
          2
        );
      } else if (format === "csv") {
        const header =
          "timestamp,cpu_percent,ram_percent,gpu_percent,disk_mb_s,net_kb_s,is_spike,spike_reason";
        const lines = exportPoints.map((p) => {
          const reason = (p.spikeReason ?? "").replace(/"/g, '""');
          return `${new Date(p.timestampMs).toISOString()},${p.cpuPercent.toFixed(2)},${p.ramPercent.toFixed(2)},${p.gpuPercent.toFixed(2)},${p.diskMbPerSec.toFixed(2)},${p.netKbPerSec.toFixed(2)},${p.isSpike},"${reason}"`;
        });
        content = [header, ...lines].join("\n");
      } else {
        const spikesList = exportPoints.filter((p) => p.isSpike);
        const mdLines = [
          `# Spektr Performance-Bericht (${metricConfig.label})`,
          "",
          `- **Host**: ${snapshot.system.hostname} (${snapshot.system.osName})`,
          `- **Zeitraum**: ${formatTimeShort(analytics.startMs)} – ${formatTimeShort(analytics.endMs)} (${exportPoints.length} Samples)`,
          `- **CPU**: Ø ${analytics.avgCpu.toFixed(1)}% / Max ${analytics.maxCpu.toFixed(1)}%`,
          `- **RAM**: Ø ${analytics.avgRam.toFixed(1)}% / Max ${analytics.maxRam.toFixed(1)}%`,
          `- **GPU**: Ø ${analytics.avgGpu.toFixed(1)}% / Max ${analytics.maxGpu.toFixed(1)}%`,
          `- **Disk**: Ø ${analytics.avgDisk.toFixed(1)} MB/s / Peak ${analytics.maxDisk.toFixed(1)} MB/s`,
          `- **Netzwerk**: Ø ${analytics.avgNet.toFixed(0)} KB/s / Peak ${analytics.maxNet.toFixed(0)} KB/s`,
          "",
          `## Top Prozesse (${metricConfig.label})`,
          "",
          "| Prozess | PID | Ø CPU | Peak CPU | Ø RAM |",
          "|---|---:|---:|---:|---:|",
          ...analytics.topProcesses.map(
            (p) =>
              `| ${p.name} | ${p.pid} | ${p.avgCpu.toFixed(1)}% | ${p.maxCpu.toFixed(1)}% | ${formatBytes(p.avgRamBytes)} |`
          ),
        ];
        if (spikesList.length > 0) {
          mdLines.push(
            "",
            "## Erkannte Spikes",
            "",
            ...spikesList.map(
              (s) =>
                `- **${formatTimeShort(s.timestampMs)}** — ${s.spikeReason ?? "Lastspitze"} (CPU ${s.cpuPercent.toFixed(1)}%, RAM ${s.ramPercent.toFixed(1)}%)`
            )
          );
        }
        content = mdLines.join("\n");
      }

      await api.exportReport(path, content);
      onActionFeedback?.({
        ok: true,
        message: `Bericht erfolgreich exportiert (${extMap.ext.toUpperCase()}).`,
      });
    } catch (err) {
      onActionFeedback?.({
        ok: false,
        message: `Export fehlgeschlagen: ${String(err)}`,
      });
    }
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
      val: `${(snapshot.disk.activePercent ?? 0).toFixed(0)}%`,
      color: "var(--accent-disk)",
      widthClass: "w-[106px]",
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

  const maxNetInList = Math.max(
    1024,
    ...displayedProcesses.map((p) => p.maxNetBytes)
  );
  const maxDiskInList = Math.max(
    1024,
    ...displayedProcesses.map((p) => p.maxDiskBytes)
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
                onClick={() => selectMetric(tab.id)}
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

        {/* Time Window + Export */}
        <div className="flex items-center gap-2 shrink-0">
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

          <div className="relative" ref={exportMenuRef}>
            <button
              onClick={() => setExportMenuOpen((v) => !v)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs font-medium cursor-pointer hover:bg-[var(--bg-surface-hover)]"
              style={{
                backgroundColor: "var(--bg-surface)",
                borderColor: "var(--border-subtle)",
                color: "var(--text-secondary)",
              }}
              title="Aktuellen Zeitraum & Spike-Analyse exportieren"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export</span>
            </button>
            {exportMenuOpen && (
              <div
                className="absolute right-0 mt-1.5 w-44 rounded-xl border p-1 z-30 flex flex-col gap-0.5 text-xs"
                style={{
                  backgroundColor: "var(--bg-drawer)",
                  borderColor: "var(--border-strong)",
                  boxShadow: "var(--shadow-float)",
                }}
              >
                <button
                  onClick={() => handleExportReport("md")}
                  className="px-2.5 py-1.5 rounded-lg text-left hover:bg-[var(--bg-surface-hover)] cursor-pointer font-medium"
                >
                  Als Markdown (.md)
                </button>
                <button
                  onClick={() => handleExportReport("csv")}
                  className="px-2.5 py-1.5 rounded-lg text-left hover:bg-[var(--bg-surface-hover)] cursor-pointer font-medium"
                >
                  Als CSV (.csv)
                </button>
                <button
                  onClick={() => handleExportReport("json")}
                  className="px-2.5 py-1.5 rounded-lg text-left hover:bg-[var(--bg-surface-hover)] cursor-pointer font-medium"
                >
                  Als JSON (.json)
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main Chart + Range/Spike Analytics Panel — Fixed-height cards to prevent ANY layout shift */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_365px] gap-4 items-stretch">
        <div className="fluent-card p-4 flex flex-col gap-3 h-[500px] overflow-hidden min-w-0">
          <div className="h-[32px] shrink-0 flex items-center justify-between gap-2 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="shrink-0" style={{ color: metricConfig.color }}>
                {metricConfig.icon}
              </span>
              <h3 className="text-sm font-semibold truncate">
                {metricConfig.label}-Verlauf & Bereichs-Analyse
              </h3>
              {metric === "gpu" && activeGpuSeries !== "overall" && (
                <button
                  onClick={handleResetGpuSeries}
                  className="px-2 py-0.5 rounded-md text-[10px] font-semibold cursor-pointer shrink-0 whitespace-nowrap transition-opacity hover:opacity-85"
                  style={{
                    backgroundColor: "var(--accent-gpu-soft)",
                    color: "var(--accent-gpu)",
                  }}
                  title="Zurück zur Gesamt-GPU-Ansicht"
                >
                  ← Gesamt
                </button>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {metric === "disk" && (
                <div
                  className="flex items-center p-0.5 rounded-lg border text-[11px]"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    borderColor: "var(--border-subtle)",
                  }}
                >
                  <button
                    onClick={() => setDiskChartMode("active")}
                    className="px-2 py-0.5 rounded-md font-medium cursor-pointer transition-colors"
                    style={{
                      backgroundColor:
                        diskChartMode === "active"
                          ? "var(--bg-surface-active)"
                          : "transparent",
                      color:
                        diskChartMode === "active"
                          ? "var(--accent-disk)"
                          : "var(--text-muted)",
                    }}
                  >
                    Aktive Zeit %
                  </button>
                  <button
                    onClick={() => setDiskChartMode("throughput")}
                    className="px-2 py-0.5 rounded-md font-medium cursor-pointer transition-colors"
                    style={{
                      backgroundColor:
                        diskChartMode === "throughput"
                          ? "var(--bg-surface-active)"
                          : "transparent",
                      color:
                        diskChartMode === "throughput"
                          ? "var(--accent-disk)"
                          : "var(--text-muted)",
                    }}
                  >
                    Durchsatz
                  </button>
                </div>
              )}
              <div
                className="text-2xl font-bold tabular-nums shrink-0 min-w-[88px] text-right whitespace-nowrap"
                style={{ color: metricConfig.color }}
              >
                {metricConfig.current}
              </div>
            </div>
          </div>

          <div className="h-[320px] shrink-0 w-full">
            <InteractiveAreaChart
              data={slicedHistory}
              valueSelector={metricConfig.selector}
              color={metricConfig.color}
              unit={metricConfig.unit}
              maxValue={metricConfig.max}
              height={320}
              selectedRange={selectedRange}
              onSelectRange={setSelectedRange}
              onHoverPoint={setHoverPoint}
            />
          </div>

          {/* Selection / Status Strip — ALWAYS rendered with fixed height so hover/selection NEVER shifts layout */}
          <div
            className="h-[34px] shrink-0 flex items-center justify-between gap-2 px-3 rounded-xl border text-xs overflow-hidden"
            style={
              isPinned
                ? {
                    backgroundColor: `${metricConfig.color}14`,
                    borderColor: `${metricConfig.color}44`,
                  }
                : {
                    backgroundColor: "var(--bg-subtle)",
                    borderColor: "var(--border-subtle)",
                    color: "var(--text-muted)",
                  }
            }
          >
            <span className="tabular-nums font-medium truncate">
              {isPinned ? (
                isRangeMode ? (
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
                )
              ) : hoverPoint ? (
                <>
                  Vorschau um{" "}
                  <strong style={{ color: "var(--text-primary)" }}>
                    {formatTimeShort(hoverPoint.timestampMs)}
                  </strong>{" "}
                  — {metricConfig.selector(hoverPoint).toFixed(1)}{" "}
                  {metricConfig.unit}
                </>
              ) : (
                "Live-Ansicht — Bereich im Diagramm aufziehen oder Punkt anklicken"
              )}
            </span>
            {isPinned ? (
              <button
                onClick={() => setSelectedRange(null)}
                className="flex items-center gap-1 text-[11px] font-semibold cursor-pointer hover:underline shrink-0 whitespace-nowrap"
                style={{ color: metricConfig.color }}
              >
                <X className="w-3.5 h-3.5" />
                Auswahl aufheben
              </button>
            ) : (
              <span className="text-[11px] tabular-nums shrink-0 whitespace-nowrap opacity-75">
                {slicedHistory.length} Samples
              </span>
            )}
          </div>

          {/* Detected Spikes Strip — Compact fixed height & internal scroll */}
          <div
            className="h-[44px] shrink-0 overflow-y-auto stable-scroll pt-2 border-t flex items-center"
            style={{ borderColor: "var(--border-subtle)" }}
          >
            {detectedSpikes.length > 0 ? (
              <div className="flex items-center gap-1.5 flex-wrap w-full">
                <span
                  className="text-[11px] font-semibold flex items-center gap-1 shrink-0 mr-0.5"
                  style={{ color: "var(--accent-danger)" }}
                >
                  <AlertTriangle className="w-3.5 h-3.5" /> Lastspitzen:
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
                      className="px-2 py-0.5 rounded-md text-[11px] font-medium cursor-pointer transition-colors whitespace-nowrap"
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
            ) : (
              <div
                className="text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                Keine Lastspitzen im aktuellen Zeitfenster erkannt.
              </div>
            )}
          </div>
        </div>

        {/* Right Panel: Metric-specific Top Processes & Range Analytics — Locked height matching chart card */}
        <div className="fluent-card p-4 flex flex-col gap-3 h-[500px] overflow-hidden min-w-0">
          <div className="h-[40px] shrink-0 flex items-center justify-between gap-2 min-w-0">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold flex items-center gap-1.5 truncate">
                <History
                  className="w-4 h-4 shrink-0"
                  style={{ color: metricConfig.color }}
                />
                <span className="truncate">
                  {isRangeMode ? "Bereichs-Auswertung" : "„Was war das gerade?“"}
                </span>
              </h3>
              <p
                className="text-[11px] tabular-nums mt-0.5 truncate"
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
            <button
              onClick={() => setSelectedRange(null)}
              tabIndex={isPinned ? 0 : -1}
              aria-hidden={!isPinned}
              className={`text-[11px] font-semibold hover:underline cursor-pointer shrink-0 whitespace-nowrap ${
                isPinned ? "" : "invisible pointer-events-none"
              }`}
              style={{ color: "var(--accent-cpu)" }}
            >
              Live
            </button>
          </div>

          {/* Summary Stat Cards — Fixed height & nowrap so range/hover toggles never shift */}
          <div className="grid grid-cols-3 gap-1.5 text-center tabular-nums shrink-0">
            <div
              className="h-[52px] px-1.5 py-1.5 rounded-lg border flex flex-col justify-center overflow-hidden"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <div
                className="text-[10px] whitespace-nowrap truncate"
                style={{ color: "var(--text-muted)" }}
              >
                CPU {isRangeMode ? "(Ø / Max)" : ""}
              </div>
              <div
                className="text-xs font-bold mt-0.5 whitespace-nowrap truncate"
                style={{ color: "var(--accent-cpu)" }}
              >
                {isRangeMode
                  ? `${analytics.avgCpu.toFixed(0)}% / ${analytics.maxCpu.toFixed(0)}%`
                  : `${analytics.avgCpu.toFixed(1)}%`}
              </div>
            </div>
            <div
              className="h-[52px] px-1.5 py-1.5 rounded-lg border flex flex-col justify-center overflow-hidden"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <div
                className="text-[10px] whitespace-nowrap truncate"
                style={{ color: "var(--text-muted)" }}
              >
                RAM {isRangeMode ? "(Ø / Max)" : ""}
              </div>
              <div
                className="text-xs font-bold mt-0.5 whitespace-nowrap truncate"
                style={{ color: "var(--accent-ram)" }}
              >
                {isRangeMode
                  ? `${analytics.avgRam.toFixed(0)}% / ${analytics.maxRam.toFixed(0)}%`
                  : `${analytics.avgRam.toFixed(1)}%`}
              </div>
            </div>
            <div
              className="h-[52px] px-1.5 py-1.5 rounded-lg border flex flex-col justify-center overflow-hidden"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <div
                className="text-[10px] whitespace-nowrap truncate"
                style={{ color: "var(--text-muted)" }}
              >
                {metric === "gpu" ? activeGpuMeta.shortLabel : "GPU"}{" "}
                {isRangeMode ? "(Ø / Max)" : ""}
              </div>
              <div
                className="text-xs font-bold mt-0.5 whitespace-nowrap truncate"
                style={{ color: "var(--accent-gpu)" }}
              >
                {metric === "gpu"
                  ? isRangeMode
                    ? `${analytics.avgGpuSelected.toFixed(0)}% / ${analytics.maxGpuSelected.toFixed(0)}%`
                    : `${analytics.avgGpuSelected.toFixed(0)}%`
                  : isRangeMode
                    ? `${analytics.avgGpu.toFixed(0)}% / ${analytics.maxGpu.toFixed(0)}%`
                    : `${analytics.avgGpu.toFixed(0)}%`}
              </div>
            </div>
          </div>

          {/* Extra GPU Engine breakdown for the selected point/range when GPU tab is active */}
          {metric === "gpu" && (
            <div
              className="shrink-0 px-3 py-2 rounded-lg border text-[11px] flex flex-col gap-1 tabular-nums"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate" style={{ color: "var(--text-muted)" }}>
                  {activeGpuSeries === "overall"
                    ? "Engines (3D · Copy · Enc · Dec)"
                    : `GPU Gesamt · ${activeGpuMeta.label}`}
                </span>
                <span
                  className="font-semibold shrink-0 whitespace-nowrap"
                  style={{ color: "var(--accent-gpu)" }}
                >
                  {activeGpuSeries === "overall"
                    ? `${analytics.avgGpu3d.toFixed(0)}% · ${analytics.avgGpuCopy.toFixed(0)}% · ${analytics.avgGpuEncode.toFixed(0)}% · ${analytics.avgGpuDecode.toFixed(0)}%`
                    : isRangeMode
                      ? `${analytics.avgGpu.toFixed(0)}% · Ø ${analytics.avgGpuSelected.toFixed(0)}%`
                      : `${analytics.avgGpu.toFixed(0)}% · ${analytics.avgGpuSelected.toFixed(0)}%`}
                </span>
              </div>
            </div>
          )}

          {/* Extra RAM Commit & Pool details when RAM tab is selected */}
          {metric === "ram" &&
            ((snapshot.memory.commitTotalBytes ?? 0) > 0 ||
              (snapshot.memory.pagedPoolBytes ?? 0) > 0 ||
              (snapshot.memory.nonPagedPoolBytes ?? 0) > 0) && (
              <div
                className="shrink-0 px-3 py-2 rounded-lg border text-[11px] flex flex-col gap-1 tabular-nums"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                {(snapshot.memory.commitTotalBytes ?? 0) > 0 && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate" style={{ color: "var(--text-muted)" }}>
                      Zugesichert (Commit)
                    </span>
                    <span
                      className="font-semibold shrink-0 whitespace-nowrap"
                      style={{ color: "var(--accent-ram)" }}
                    >
                      {formatBytes(snapshot.memory.commitTotalBytes ?? 0)}
                      {(snapshot.memory.commitLimitBytes ?? 0) > 0
                        ? ` / ${formatBytes(snapshot.memory.commitLimitBytes ?? 0)}`
                        : ""}
                    </span>
                  </div>
                )}
                {((snapshot.memory.pagedPoolBytes ?? 0) > 0 ||
                  (snapshot.memory.nonPagedPoolBytes ?? 0) > 0) && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate" style={{ color: "var(--text-muted)" }}>
                      Ausgelagerter / Nicht-ausgel. Pool
                    </span>
                    <span className="font-medium shrink-0 whitespace-nowrap">
                      {formatBytes(snapshot.memory.pagedPoolBytes ?? 0)} /{" "}
                      {formatBytes(snapshot.memory.nonPagedPoolBytes ?? 0)}
                    </span>
                  </div>
                )}
              </div>
            )}

          {/* Extra Disk / Net range stats when Disk or Net tab is selected */}
          {metric === "disk" && (
            <div
              className="shrink-0 px-3 py-2 rounded-lg border text-[11px] flex flex-col gap-1 tabular-nums"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate" style={{ color: "var(--text-muted)" }}>
                  Aktive Zeit · Ø Antwortzeit
                </span>
                <span
                  className="font-bold shrink-0 whitespace-nowrap"
                  style={{ color: metricConfig.color }}
                >
                  {(snapshot.disk.activePercent ?? 0).toFixed(0)}% ·{" "}
                  {(snapshot.disk.avgResponseMs ?? 0).toFixed(1)} ms
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate" style={{ color: "var(--text-muted)" }}>
                  {isRangeMode
                    ? "Durchsatz (Ø / Peak)"
                    : "Lesen / Schreiben"}
                </span>
                <span className="font-semibold shrink-0 whitespace-nowrap">
                  {isRangeMode
                    ? `${analytics.avgDisk.toFixed(1)} / ${analytics.maxDisk.toFixed(1)} MB/s`
                    : `${formatSpeed(snapshot.disk.readBytesPerSec)} / ${formatSpeed(snapshot.disk.writeBytesPerSec)}`}
                </span>
              </div>
            </div>
          )}

          {metric === "net" && (
            <div
              className="shrink-0 px-3 py-2 rounded-lg border text-[11px] flex flex-col gap-1 tabular-nums"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate" style={{ color: "var(--text-muted)" }}>
                  {isRangeMode ? "Durchsatz (Ø / Peak)" : "Netzwerk Durchsatz"}
                </span>
                <span
                  className="font-bold shrink-0 whitespace-nowrap"
                  style={{ color: metricConfig.color }}
                >
                  {isRangeMode
                    ? `${formatSpeed(analytics.avgNet * 1024)} / ${formatSpeed(analytics.maxNet * 1024)}`
                    : formatSpeed(
                        snapshot.network.rxBytesPerSec +
                          snapshot.network.txBytesPerSec
                      )}
                </span>
              </div>
              {!isRangeMode && (
                <div className="flex items-center justify-between gap-2">
                  <span
                    className="truncate"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Download / Upload
                  </span>
                  <span className="font-semibold shrink-0 whitespace-nowrap">
                    ↓ {formatSpeed(snapshot.network.rxBytesPerSec)} · ↑{" "}
                    {formatSpeed(snapshot.network.txBytesPerSec)}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Metric-Specific Top Processes List — Flex-1 scrollable inside fixed-height card */}
          <div className="flex-1 min-h-0 flex flex-col gap-1.5">
            <div className="h-5 shrink-0 flex items-center justify-between gap-2">
              <div
                className="text-[10px] font-semibold uppercase tracking-wider truncate whitespace-nowrap"
                style={{ color: "var(--text-muted)" }}
              >
                {isRangeMode
                  ? metricConfig.listTitleRange
                  : metricConfig.listTitleSingle}
              </div>
              {totalAvailableProcesses > 5 && (
                <button
                  onClick={() => setShowAllProcesses((v) => !v)}
                  className="text-[11px] font-semibold hover:underline cursor-pointer shrink-0 whitespace-nowrap"
                  style={{ color: metricConfig.color }}
                >
                  {showAllProcesses
                    ? "Weniger"
                    : `Alle anzeigen (${totalAvailableProcesses})`}
                </button>
              )}
            </div>

            {displayedProcesses.length === 0 ? (
              <div
                className="flex-1 min-h-0 p-4 rounded-xl border flex flex-col items-center justify-center gap-2.5 text-center text-xs"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-subtle)",
                  color: "var(--text-muted)",
                }}
              >
                {metric === "net" && !snapshot.network.perProcessAvailable ? (
                  <>
                    <Shield
                      className="w-5 h-5 opacity-80"
                      style={{ color: "var(--accent-net)" }}
                    />
                    <div className="font-semibold" style={{ color: "var(--text-primary)" }}>
                      Administratorrechte erforderlich
                    </div>
                    <p className="text-[11px] leading-relaxed max-w-[260px]">
                      Windows stellt den Netzwerk-Datendurchsatz pro Prozess nur
                      über Kernel-ETW bereit.
                    </p>
                    {onRestartAsAdmin && (
                      <button
                        onClick={onRestartAsAdmin}
                        className="mt-0.5 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold text-white cursor-pointer transition-opacity hover:opacity-90"
                        style={{ backgroundColor: "var(--accent-net)" }}
                      >
                        <Shield className="w-3.5 h-3.5" />
                        Als Admin neu starten
                      </button>
                    )}
                  </>
                ) : (
                  metricConfig.emptyText
                )}
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-y-auto stable-scroll pr-0.5 flex flex-col gap-1.5">
                {displayedProcesses.map((bp) => {
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
                    primaryVal = isRangeMode
                      ? `Ø ${formatSpeed(bp.avgNetBytes)}`
                      : formatSpeed(bp.avgNetBytes);
                    if (isRangeMode) {
                      secondaryVal = `Peak ${formatSpeed(bp.maxNetBytes)}`;
                    } else {
                      secondaryVal = `↓ ${formatSpeed(bp.avgNetRxBytes)} · ↑ ${formatSpeed(bp.avgNetTxBytes)}`;
                    }
                    barPct = Math.min(
                      100,
                      Math.max(4, (bp.maxNetBytes / maxNetInList) * 100)
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

                  const blameFallback: BlameProcess = {
                    pid: bp.pid,
                    name: bp.name,
                    subtitle: bp.subtitle,
                    category: bp.category,
                    cpuPercent: bp.avgCpu,
                    gpuPercent: bp.avgGpu,
                    memoryBytes: bp.avgRamBytes,
                    diskBytesPerSec: bp.avgDiskBytes,
                    netRxBytesPerSec: bp.avgNetRxBytes,
                    netTxBytesPerSec: bp.avgNetTxBytes,
                    netConnections: bp.maxNetConns,
                    netListeningPorts: bp.maxNetPorts,
                  };

                  return (
                    <button
                      key={bp.key}
                      onClick={() => onInspectPid(bp.pid, blameFallback)}
                      className="h-[56px] shrink-0 flex flex-col justify-between px-2.5 py-2 rounded-xl border text-left hover:bg-[var(--bg-surface-hover)] cursor-pointer transition-colors"
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        borderColor: "var(--border-subtle)",
                      }}
                    >
                      <div className="flex items-center justify-between gap-2 w-full min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: cat.color }}
                          />
                          <div className="min-w-0 leading-tight">
                            <div className="text-xs font-semibold truncate">
                              {bp.name}
                            </div>
                            <div
                              className="text-[10px] truncate mt-0.5"
                              style={{ color: "var(--text-muted)" }}
                            >
                              PID {bp.pid}
                              {bp.subtitle ? ` • ${bp.subtitle}` : ""}
                            </div>
                          </div>
                        </div>

                        <div className="h-[30px] flex flex-col justify-center items-end shrink-0 tabular-nums leading-tight">
                          <div
                            className="text-xs font-bold whitespace-nowrap"
                            style={{ color: metricConfig.color }}
                          >
                            {primaryVal}
                          </div>
                          {secondaryVal && (
                            <div
                              className="text-[10px] whitespace-nowrap mt-0.5"
                              style={{ color: "var(--text-muted)" }}
                            >
                              {secondaryVal}
                            </div>
                          )}
                        </div>
                      </div>

                      <div
                        className="h-1 w-full rounded-full overflow-hidden shrink-0"
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
                })}
              </div>
            )}

            {/* Residual CPU note — ALWAYS rendered on CPU tab with fixed height so hover NEVER jumps */}
            {metric === "cpu" && (
              <div
                className={`h-[34px] shrink-0 px-2.5 rounded-xl border text-[11px] flex items-center justify-between gap-2 transition-opacity ${
                  analytics.avgUnaccounted >= 4 || analytics.maxUnaccounted >= 12
                    ? "opacity-100"
                    : "opacity-55"
                }`}
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
                <span className="font-semibold tabular-nums shrink-0 whitespace-nowrap">
                  {isRangeMode
                    ? `Ø ${analytics.avgUnaccounted.toFixed(1)}% · Peak ${analytics.maxUnaccounted.toFixed(0)}%`
                    : `${analytics.avgUnaccounted.toFixed(1)}%`}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Hardware Deep-Dive Grid — Context-aware for GPU & Disk (Task-Manager style) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {metric === "gpu" ? (
          <>
            {/* GPU Engines (3D, Copy, Video Encode, Video Decode) & Memory Breakdown */}
            <div className="fluent-card p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-semibold truncate">
                  GPU-Engines & Speicher
                </h4>
                <span
                  className="text-xs font-semibold tabular-nums shrink-0"
                  style={{ color: "var(--accent-gpu)" }}
                >
                  {snapshot.gpu.name}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                {gpuBottomSlots.map((slotKey, idx) => {
                  const meta = GPU_SERIES_META[slotKey];
                  const val = getLiveGpuSeriesVal(slotKey) ?? 0;
                  const series = gpuEngineSeries[slotKey];
                  return (
                    <button
                      type="button"
                      key={slotKey}
                      onClick={() => handleSwapGpuSeries(idx)}
                      className="group p-2.5 rounded-xl border flex flex-col gap-1.5 text-left cursor-pointer transition-colors hover:bg-[var(--bg-surface-hover)] hover:border-[var(--accent-gpu)]"
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        borderColor: "var(--border-subtle)",
                      }}
                      title={`${meta.label} in das Hauptdiagramm tauschen`}
                    >
                      <div className="flex items-center justify-between text-[11px] tabular-nums w-full gap-1">
                        <span
                          className="font-medium flex items-center gap-1 truncate"
                          style={{ color: "var(--text-secondary)" }}
                        >
                          <span className="truncate">{meta.label}</span>
                          <ArrowUpDown
                            className="w-3 h-3 opacity-0 group-hover:opacity-80 transition-opacity shrink-0"
                            style={{ color: "var(--accent-gpu)" }}
                          />
                        </span>
                        <span
                          className="font-bold shrink-0"
                          style={{ color: "var(--accent-gpu)" }}
                        >
                          {val.toFixed(0)}%
                        </span>
                      </div>
                      <Sparkline
                        data={series}
                        color="var(--accent-gpu)"
                        width={220}
                        height={36}
                        maxValue={100}
                        className="w-full block"
                      />
                    </button>
                  );
                })}
              </div>

              {/* Dedicated, Shared & Combined GPU Memory */}
              <div className="flex flex-col gap-2 pt-1">
                {(() => {
                  const dedUsed = snapshot.gpu.vramUsedBytes;
                  const dedTot = snapshot.gpu.vramTotalBytes;
                  const dedPct = dedTot > 0 ? (dedUsed / dedTot) * 100 : 0;
                  const shUsed = snapshot.gpu.sharedUsedBytes ?? 0;
                  const shTot = snapshot.gpu.sharedTotalBytes ?? 0;
                  const shPct = shTot > 0 ? (shUsed / shTot) * 100 : 0;
                  const allUsed = dedUsed + shUsed;
                  const allTot = dedTot + shTot;

                  return (
                    <>
                      <div>
                        <div className="flex items-center justify-between text-[11px] tabular-nums mb-1">
                          <span style={{ color: "var(--text-muted)" }}>
                            Dedizierter GPU-Speicher
                          </span>
                          <span className="font-semibold">
                            {formatBytes(dedUsed)} / {formatBytes(dedTot)}
                          </span>
                        </div>
                        <div
                          className="h-2 w-full rounded-full overflow-hidden"
                          style={{ backgroundColor: "var(--bg-surface-solid)" }}
                        >
                          <div
                            className="h-full w-full rounded-full origin-left transition-transform duration-300"
                            style={{
                              transform: `scaleX(${Math.min(1, Math.max(0.01, dedPct / 100))})`,
                              backgroundColor: "var(--accent-gpu)",
                            }}
                          />
                        </div>
                      </div>

                      {shTot > 0 && (
                        <div>
                          <div className="flex items-center justify-between text-[11px] tabular-nums mb-1">
                            <span style={{ color: "var(--text-muted)" }}>
                              Gemeinsamer GPU-Speicher
                            </span>
                            <span className="font-semibold">
                              {formatBytes(shUsed)} / {formatBytes(shTot)}
                            </span>
                          </div>
                          <div
                            className="h-2 w-full rounded-full overflow-hidden"
                            style={{
                              backgroundColor: "var(--bg-surface-solid)",
                            }}
                          >
                            <div
                              className="h-full w-full rounded-full origin-left transition-transform duration-300 opacity-75"
                              style={{
                                transform: `scaleX(${Math.min(1, Math.max(0.01, shPct / 100))})`,
                                backgroundColor: "var(--accent-ram)",
                              }}
                            />
                          </div>
                        </div>
                      )}

                      {allTot > 0 && (
                        <div
                          className="flex items-center justify-between text-[11px] tabular-nums pt-1 border-t"
                          style={{
                            borderColor: "var(--border-subtle)",
                            color: "var(--text-secondary)",
                          }}
                        >
                          <span>GPU-Speicher gesamt</span>
                          <span className="font-semibold">
                            {formatBytes(allUsed)} / {formatBytes(allTot)}
                          </span>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>

            {/* Right Card on GPU Tab: GPU Details, Clocks, Fan & Driver Info */}
            <div className="fluent-card p-4 flex flex-col gap-3">
              <h4 className="text-sm font-semibold">
                GPU-Sensoren & Treiberdetails
              </h4>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs tabular-nums">
                <div
                  className="p-2.5 rounded-xl border"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    borderColor: "var(--border-subtle)",
                  }}
                >
                  <div
                    className="text-[10px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Temperatur
                  </div>
                  <div className="text-sm font-bold mt-0.5 flex items-center gap-1 text-emerald-500">
                    <Thermometer className="w-3.5 h-3.5" />
                    {snapshot.gpu.temperatureC != null
                      ? `${snapshot.gpu.temperatureC.toFixed(0)} °C`
                      : "–"}
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
                    className="text-[10px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Leistung
                  </div>
                  <div className="text-sm font-bold mt-0.5 flex items-center gap-1 text-amber-500">
                    <Zap className="w-3.5 h-3.5" />
                    {snapshot.gpu.powerWatts != null
                      ? `${snapshot.gpu.powerWatts.toFixed(1)} W`
                      : "–"}
                  </div>
                  {snapshot.gpu.powerLimitWatts != null && (
                    <div
                      className="text-[10px] mt-0.5"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Limit {snapshot.gpu.powerLimitWatts.toFixed(0)} W
                    </div>
                  )}
                </div>

                <div
                  className="p-2.5 rounded-xl border"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    borderColor: "var(--border-subtle)",
                  }}
                >
                  <div
                    className="text-[10px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Lüfter
                  </div>
                  <div className="text-sm font-bold mt-0.5 flex items-center gap-1">
                    <Fan className="w-3.5 h-3.5 text-sky-500" />
                    {snapshot.gpu.fanSpeedPercent != null
                      ? `${snapshot.gpu.fanSpeedPercent}%`
                      : "–"}
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
                    className="text-[10px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    GPU-Takt
                  </div>
                  <div
                    className="text-sm font-bold mt-0.5 flex items-center gap-1"
                    style={{ color: "var(--accent-gpu)" }}
                  >
                    <Gauge className="w-3.5 h-3.5" />
                    {snapshot.gpu.clockMhz != null
                      ? `${snapshot.gpu.clockMhz} MHz`
                      : "–"}
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
                    className="text-[10px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    VRAM-Takt
                  </div>
                  <div className="text-sm font-bold mt-0.5">
                    {snapshot.gpu.memoryClockMhz != null
                      ? `${snapshot.gpu.memoryClockMhz} MHz`
                      : "–"}
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
                    className="text-[10px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Hersteller
                  </div>
                  <div className="text-sm font-bold mt-0.5 truncate">
                    {snapshot.gpu.vendor}
                  </div>
                </div>
              </div>

              <div
                className="p-3 rounded-xl border text-xs flex flex-col gap-1.5 tabular-nums"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span style={{ color: "var(--text-muted)" }}>
                    Treiberversion
                  </span>
                  <span className="font-semibold">
                    {snapshot.gpu.driverVersion ?? "–"}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span style={{ color: "var(--text-muted)" }}>
                    Treiberdatum
                  </span>
                  <span className="font-semibold">
                    {snapshot.gpu.driverDate ?? "–"}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span style={{ color: "var(--text-muted)" }}>
                    Physischer Standort
                  </span>
                  <span className="font-semibold truncate">
                    {snapshot.gpu.pciLocation ?? "–"}
                  </span>
                </div>
              </div>
            </div>
          </>
        ) : metric === "disk" ? (
          <>
            {/* Disk Activity & Per-Drive Deep Dive (Windows Task Manager style) */}
            <div className="fluent-card p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-semibold">
                  Datenträger-Aktivität & Laufwerke ({snapshot.disk.drives.length})
                </h4>
                <span
                  className="text-xs font-semibold tabular-nums"
                  style={{ color: "var(--accent-disk)" }}
                >
                  Aktive Zeit {(snapshot.disk.activePercent ?? 0).toFixed(0)}%
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs tabular-nums">
                <div
                  className="p-2.5 rounded-xl border"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    borderColor: "var(--border-subtle)",
                  }}
                >
                  <div
                    className="text-[10px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Aktive Zeit
                  </div>
                  <div
                    className="text-sm font-bold mt-0.5"
                    style={{ color: "var(--accent-disk)" }}
                  >
                    {(snapshot.disk.activePercent ?? 0).toFixed(0)}%
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
                    className="text-[10px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Ø Antwortzeit
                  </div>
                  <div className="text-sm font-bold mt-0.5">
                    {(snapshot.disk.avgResponseMs ?? 0).toFixed(1)} ms
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
                    className="text-[10px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Lesen
                  </div>
                  <div className="text-sm font-bold mt-0.5 text-emerald-500">
                    {formatSpeed(snapshot.disk.readBytesPerSec)}
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
                    className="text-[10px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Schreiben
                  </div>
                  <div className="text-sm font-bold mt-0.5 text-amber-500">
                    {formatSpeed(snapshot.disk.writeBytesPerSec)}
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                {snapshot.disk.drives.map((d) => {
                  const typeLabel = d.busType
                    ? `${d.kind !== "Unknown" ? d.kind : "Laufwerk"} (${d.busType})`
                    : d.kind;
                  const actPct = d.activePercent ?? 0;
                  return (
                    <div
                      key={d.mountPoint}
                      className="p-3 rounded-xl border flex flex-col gap-2 text-xs tabular-nums"
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        borderColor: "var(--border-subtle)",
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-semibold flex items-center gap-1.5 truncate">
                            <span>{d.mountPoint}</span>
                            {d.model && (
                              <span
                                className="font-medium truncate"
                                style={{ color: "var(--text-secondary)" }}
                                title={d.model}
                              >
                                {d.model}
                              </span>
                            )}
                            {d.isSystemDrive && (
                              <span
                                className="text-[10px] px-1.5 py-0.5 rounded font-semibold shrink-0"
                                style={{
                                  backgroundColor: "var(--accent-disk-soft)",
                                  color: "var(--accent-disk)",
                                }}
                              >
                                System
                              </span>
                            )}
                          </div>
                          <div
                            className="text-[10px] mt-0.5"
                            style={{ color: "var(--text-muted)" }}
                          >
                            {typeLabel} · {d.fileSystem} ·{" "}
                            {formatBytes(d.usedBytes)} /{" "}
                            {formatBytes(d.totalBytes)} ({formatBytes(d.availableBytes)} frei)
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div
                            className="text-xs font-bold"
                            style={{ color: "var(--accent-disk)" }}
                          >
                            {actPct.toFixed(0)}% aktiv
                          </div>
                          <div
                            className="text-[10px]"
                            style={{ color: "var(--text-muted)" }}
                          >
                            {(d.avgResponseMs ?? 0).toFixed(1)} ms
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <div
                          className="h-1.5 flex-1 rounded-full overflow-hidden"
                          style={{ backgroundColor: "var(--bg-surface-solid)" }}
                        >
                          <div
                            className="h-full w-full rounded-full origin-left transition-transform duration-300"
                            style={{
                              transform: `scaleX(${Math.min(1, Math.max(0.02, actPct / 100))})`,
                              backgroundColor:
                                actPct > 85 ? "#ef4444" : "var(--accent-disk)",
                            }}
                          />
                        </div>
                        <span
                          className="text-[10px] shrink-0 whitespace-nowrap"
                          style={{ color: "var(--text-muted)" }}
                        >
                          R {formatSpeed(d.readBytesPerSec ?? 0)} · W{" "}
                          {formatSpeed(d.writeBytesPerSec ?? 0)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right Card on Disk Tab: Hardware & Sensoren */}
            <div className="fluent-card p-4 flex flex-col gap-3">
              <h4 className="text-sm font-semibold">Hardware & Sensoren</h4>
              <div className="grid grid-cols-2 gap-2.5 text-xs">
                <div
                  className="p-3 rounded-xl border min-h-[96px] flex flex-col justify-between"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    borderColor: "var(--border-subtle)",
                  }}
                >
                  <div>
                    <div
                      className="text-[11px] mb-1"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Prozessor
                    </div>
                    <div
                      className="font-semibold truncate"
                      title={snapshot.cpu.brand}
                    >
                      {snapshot.cpu.brand}
                    </div>
                    <div
                      className="text-[11px] mt-1 tabular-nums truncate"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {snapshot.cpu.physicalCores} Kerne /{" "}
                      {snapshot.cpu.logicalCores} Threads ·{" "}
                      {(snapshot.cpu.frequencyMhz / 1000).toFixed(2)} GHz
                    </div>
                  </div>
                </div>
                <div
                  className="p-3 rounded-xl border min-h-[96px] flex flex-col justify-between"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    borderColor: "var(--border-subtle)",
                  }}
                >
                  <div>
                    <div
                      className="text-[11px] mb-1"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Grafikkarte
                    </div>
                    <div
                      className="font-semibold truncate"
                      title={snapshot.gpu.name}
                    >
                      {snapshot.gpu.name}
                    </div>
                  </div>
                  <div className="text-[11px] mt-1.5 flex items-center gap-2 tabular-nums">
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
                  className="p-3 rounded-xl border min-h-[82px]"
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
                  className="p-3 rounded-xl border min-h-[82px]"
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
          </>
        ) : (
          <>
            <div className="fluent-card p-4">
              <div className="flex items-center justify-between gap-2 mb-3">
                <h4 className="text-sm font-semibold truncate">
                  Logische CPU-Kerne ({snapshot.cpu.logicalCores})
                </h4>
                <div
                  className="text-xs tabular-nums flex items-center gap-2.5 shrink-0 whitespace-nowrap"
                  style={{ color: "var(--text-muted)" }}
                  title={
                    snapshot.cpu.baseFrequencyMhz &&
                    snapshot.cpu.baseFrequencyMhz > 0
                      ? `Aktueller Effektivtakt (Basis: ${(snapshot.cpu.baseFrequencyMhz / 1000).toFixed(2)} GHz)`
                      : undefined
                  }
                >
                  <span
                    className="font-semibold"
                    style={{ color: "var(--accent-cpu)" }}
                  >
                    {(snapshot.cpu.frequencyMhz / 1000).toFixed(2)} GHz
                  </span>
                  {snapshot.cpu.baseFrequencyMhz != null &&
                    snapshot.cpu.baseFrequencyMhz > 0 && (
                      <span className="text-[11px] opacity-75">
                        Basis {(snapshot.cpu.baseFrequencyMhz / 1000).toFixed(2)}{" "}
                        GHz
                      </span>
                    )}
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {snapshot.cpu.perCore.map((val, idx) => {
                  const coreMhz = snapshot.cpu.perCoreFrequencyMhz?.[idx];
                  return (
                    <div
                      key={idx}
                      className="p-2 rounded-xl border"
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        borderColor: "var(--border-subtle)",
                      }}
                      title={
                        coreMhz
                          ? `Kern ${idx}: ${val.toFixed(0)}% • ${(coreMhz / 1000).toFixed(2)} GHz`
                          : `Kern ${idx}: ${val.toFixed(0)}%`
                      }
                    >
                      <div className="flex items-center justify-between text-[11px] tabular-nums mb-1 gap-1">
                        <span style={{ color: "var(--text-muted)" }}>
                          Kern {idx}
                        </span>
                        <span className="flex items-center gap-1.5">
                          {coreMhz != null && coreMhz > 0 && (
                            <span
                              className="text-[10px]"
                              style={{ color: "var(--text-muted)" }}
                            >
                              {(coreMhz / 1000).toFixed(1)}G
                            </span>
                          )}
                          <span className="font-semibold">
                            {val.toFixed(0)}%
                          </span>
                        </span>
                      </div>
                      <div
                        className="h-1.5 rounded-full overflow-hidden"
                        style={{ backgroundColor: "var(--bg-surface-solid)" }}
                      >
                        <div
                          className="h-full w-full rounded-full origin-left transition-transform duration-300"
                          style={{
                            transform: `scaleX(${Math.min(1, Math.max(0.03, val / 100))})`,
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
                  );
                })}
              </div>
            </div>

            <div className="fluent-card p-4 flex flex-col gap-3">
              <h4 className="text-sm font-semibold">Hardware & Sensoren</h4>
              <div className="grid grid-cols-2 gap-2.5 text-xs">
                <div
                  className="p-3 rounded-xl border min-h-[96px] flex flex-col justify-between"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    borderColor: "var(--border-subtle)",
                  }}
                  title={
                    snapshot.cpu.sensorSource
                      ? `CPU-Sensoren via ${snapshot.cpu.sensorSource}`
                      : "Realtakt via Windows PDH. Für CPU-Temperatur & Watt auf Desktop-Boards ohne ACPI/EMI wird laufendes HWiNFO (Shared Memory) oder LibreHardwareMonitor automatisch erkannt."
                  }
                >
                  <div>
                    <div
                      className="text-[11px] mb-1"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Prozessor
                    </div>
                    <div
                      className="font-semibold truncate"
                      title={snapshot.cpu.brand}
                    >
                      {snapshot.cpu.brand}
                    </div>
                    <div
                      className="text-[11px] mt-1 tabular-nums truncate"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {snapshot.cpu.physicalCores} Kerne /{" "}
                      {snapshot.cpu.logicalCores} Threads ·{" "}
                      <span
                        className="font-medium"
                        style={{ color: "var(--accent-cpu)" }}
                      >
                        {(snapshot.cpu.frequencyMhz / 1000).toFixed(2)} GHz
                      </span>
                    </div>
                  </div>
                  <div
                    className="text-[11px] mt-1.5 flex items-center gap-2 tabular-nums min-h-[16px]"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {snapshot.cpu.temperatureC != null && (
                      <span
                        className={`inline-flex items-center gap-0.5 font-medium ${
                          snapshot.cpu.temperatureC >= 85
                            ? "text-red-500"
                            : snapshot.cpu.temperatureC >= 70
                              ? "text-amber-500"
                              : "text-emerald-500"
                        }`}
                      >
                        <Thermometer className="w-3 h-3" />
                        {snapshot.cpu.temperatureC.toFixed(0)}°C
                      </span>
                    )}
                    {snapshot.cpu.powerWatts != null && (
                      <span className="inline-flex items-center gap-0.5 text-amber-500 font-medium">
                        <Zap className="w-3 h-3" />
                        {snapshot.cpu.powerWatts.toFixed(1)}W
                      </span>
                    )}
                    {snapshot.cpu.temperatureC == null &&
                      snapshot.cpu.powerWatts == null && (
                        <span
                          className="text-[10px] truncate"
                          style={{ color: "var(--text-muted)" }}
                        >
                          Basis{" "}
                          {(
                            (snapshot.cpu.baseFrequencyMhz ??
                              snapshot.cpu.frequencyMhz) / 1000
                          ).toFixed(2)}{" "}
                          GHz
                        </span>
                      )}
                  </div>
                </div>

                <div
                  className="p-3 rounded-xl border min-h-[96px] flex flex-col justify-between"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    borderColor: "var(--border-subtle)",
                  }}
                >
                  <div>
                    <div
                      className="text-[11px] mb-1"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Grafikkarte
                    </div>
                    <div
                      className="font-semibold truncate"
                      title={snapshot.gpu.name}
                    >
                      {snapshot.gpu.name}
                    </div>
                    <div
                      className="text-[11px] mt-1 tabular-nums truncate"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      3D {(snapshot.gpu.engine3dPercent ?? 0).toFixed(0)}% ·
                      VRAM {formatBytes(snapshot.gpu.vramUsedBytes)}
                    </div>
                  </div>
                  <div
                    className="text-[11px] mt-1.5 flex items-center gap-2 tabular-nums min-h-[16px]"
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
                    {snapshot.gpu.clockMhz != null && (
                      <span
                        className="text-[10px]"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {snapshot.gpu.clockMhz} MHz
                      </span>
                    )}
                  </div>
                </div>

                <div
                  className="p-3 rounded-xl border min-h-[82px]"
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
                  className="p-3 rounded-xl border min-h-[82px]"
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
          </>
        )}
      </div>
    </div>
  );
});

PerformanceView.displayName = "PerformanceView";
