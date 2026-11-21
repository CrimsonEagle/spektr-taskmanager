import React, { useEffect, useMemo } from "react";
import {
  ArrowDown,
  ArrowsOutSimple as Maximize2,
  ArrowUp,
  BatteryCharging,
  GearSix as Settings,
  HardDrives as HardDrive,
  X,
} from "@phosphor-icons/react";
import { HudMetricsConfig } from "../hooks/useSettings";
import { formatBytes, formatSpeed } from "../lib/format";
import { api } from "../lib/tauri";
import { TelemetrySnapshot } from "../types/telemetry";
import { SpektrLogo } from "./SpektrLogo";

interface MiniHudProps {
  snapshot: TelemetrySnapshot | null;
  hudMetrics: HudMetricsConfig;
  onExitMiniHud: () => void;
  onOpenSettings: () => void;
}

export function computeMiniHudHeight(
  hudMetrics: HudMetricsConfig,
  hasBattery: boolean
): number {
  let height = 56; // Header + vertical padding
  const primaryCount =
    (hudMetrics.cpu ? 1 : 0) +
    (hudMetrics.ram ? 1 : 0) +
    (hudMetrics.gpu ? 1 : 0);
  if (primaryCount > 0) height += 74;

  const ioCount = (hudMetrics.disk ? 1 : 0) + (hudMetrics.network ? 1 : 0);
  if (ioCount > 0) height += 54;

  const showBattery = hudMetrics.battery && hasBattery;
  if (hudMetrics.topProcess || showBattery) height += 38;

  return Math.max(150, Math.min(340, height));
}

export const MiniHud: React.FC<MiniHudProps> = React.memo(
  ({ snapshot, hudMetrics, onExitMiniHud, onOpenSettings }) => {
    const hasBattery = snapshot?.battery.hasBattery ?? false;
    const targetHeight = useMemo(
      () => computeMiniHudHeight(hudMetrics, hasBattery),
      [hudMetrics, hasBattery]
    );

    useEffect(() => {
      api.setMiniHud(true, targetHeight).catch(() => {});
    }, [targetHeight]);

    const handleDrag = (e: React.MouseEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest("button")) return;
      api.window.startDragging().catch(() => {});
    };

    const cpu = snapshot?.cpu.totalUsage ?? 0;
    const cpuGhz = snapshot ? (snapshot.cpu.frequencyMhz / 1000).toFixed(2) : "–";
    const cpuSub = snapshot
      ? [
          `${cpuGhz} GHz`,
          snapshot.cpu.temperatureC != null
            ? `${snapshot.cpu.temperatureC.toFixed(0)}°C`
            : null,
          snapshot.cpu.powerWatts != null
            ? `${snapshot.cpu.powerWatts.toFixed(0)}W`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "–";
    const ram = snapshot?.memory.usagePercent ?? 0;
    const ramSub = snapshot
      ? `${(snapshot.memory.usedBytes / 1073741824).toFixed(1)}/${(snapshot.memory.totalBytes / 1073741824).toFixed(0)} GB`
      : "–";
    const gpu = snapshot?.gpu.available ? (snapshot.gpu.usagePercent ?? 0) : 0;
    const gpuSub = snapshot?.gpu.available
      ? snapshot.gpu.temperatureC != null
        ? `${snapshot.gpu.temperatureC.toFixed(0)}°C${snapshot.gpu.vramTotalBytes > 0 ? ` · ${formatBytes(snapshot.gpu.vramUsedBytes, 0)}` : ""}`
        : snapshot.gpu.vramTotalBytes > 0
          ? formatBytes(snapshot.gpu.vramUsedBytes, 1)
          : "Aktiv"
      : "N/V";

    const topProc = snapshot?.latestPoint.topCpu[0];

    const primaryTiles = [
      hudMetrics.cpu && {
        key: "cpu",
        label: "CPU",
        value: cpu,
        sub: cpuSub,
        color: "var(--accent-cpu)",
      },
      hudMetrics.ram && {
        key: "ram",
        label: "RAM",
        value: ram,
        sub: ramSub,
        color: "var(--accent-ram)",
      },
      hudMetrics.gpu && {
        key: "gpu",
        label: "GPU",
        value: gpu,
        sub: gpuSub,
        color: "var(--accent-gpu)",
      },
    ].filter(Boolean) as {
      key: string;
      label: string;
      value: number;
      sub: string;
      color: string;
    }[];

    const showBattery = hudMetrics.battery && hasBattery;
    const showIoRow = hudMetrics.disk || hudMetrics.network;
    const showFooter = hudMetrics.topProcess || showBattery;

    return (
      <div
        onMouseDown={handleDrag}
        className="h-full w-full mica-canvas flex flex-col justify-between gap-2 p-3 select-none border overflow-hidden"
        style={{ borderColor: "var(--border-strong)" }}
      >
        {/* Top Bar */}
        <div className="flex items-center justify-between shrink-0">
          <div className="flex items-center gap-1.5">
            <SpektrLogo size={20} />
            <span className="text-xs font-semibold">Spektr HUD</span>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={onOpenSettings}
              className="w-6 h-6 rounded-md flex items-center justify-center cursor-pointer hover:bg-[var(--bg-surface-hover)]"
              style={{ color: "var(--text-secondary)" }}
              title="Einstellungen öffnen"
            >
              <Settings className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onExitMiniHud}
              className="px-2 py-1 rounded-md text-[11px] font-medium flex items-center gap-1 cursor-pointer hover:bg-[var(--bg-surface-hover)]"
              style={{ color: "var(--accent-cpu)" }}
              title="Vollansicht wiederherstellen"
            >
              <Maximize2 className="w-3 h-3" />
              Vollbild
            </button>
            <button
              onClick={() => api.window.close()}
              className="w-6 h-6 rounded-md flex items-center justify-center cursor-pointer hover:bg-red-500 hover:text-white"
              style={{ color: "var(--text-secondary)" }}
              title="Schließen"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Primary Resource Tiles (CPU / RAM / GPU) */}
        {primaryTiles.length > 0 && (
          <div
            className="grid gap-2 shrink-0"
            style={{
              gridTemplateColumns: `repeat(${primaryTiles.length}, minmax(0, 1fr))`,
            }}
          >
            {primaryTiles.map((g) => (
              <div
                key={g.key}
                className="p-2 rounded-xl border min-w-0"
                style={{
                  backgroundColor: "var(--bg-surface)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <div className="flex items-center justify-between text-[10px] font-semibold">
                  <span style={{ color: "var(--text-muted)" }}>{g.label}</span>
                  <span className="tabular-nums" style={{ color: g.color }}>
                    {g.value.toFixed(0)}%
                  </span>
                </div>
                <div
                  className="text-[10px] tabular-nums truncate mt-0.5"
                  style={{ color: "var(--text-muted)" }}
                >
                  {g.sub}
                </div>
                <div
                  className="h-1.5 w-full rounded-full mt-1.5 overflow-hidden"
                  style={{ backgroundColor: "var(--bg-subtle)" }}
                >
                  <div
                    className="h-full w-full rounded-full origin-left transition-transform duration-300"
                    style={{
                      transform: `scaleX(${Math.min(1, Math.max(0.02, g.value / 100))})`,
                      backgroundColor: g.color,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* I/O Row: Disk & Network */}
        {showIoRow && (
          <div
            className="grid gap-2 shrink-0 text-[10px] tabular-nums"
            style={{
              gridTemplateColumns: `repeat(${(hudMetrics.disk ? 1 : 0) + (hudMetrics.network ? 1 : 0)}, minmax(0, 1fr))`,
            }}
          >
            {hudMetrics.disk && (
              <div
                className="px-2.5 py-1.5 rounded-xl border flex flex-col gap-0.5 min-w-0"
                style={{
                  backgroundColor: "var(--bg-surface)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <span
                  className="font-semibold flex items-center gap-1"
                  style={{ color: "var(--accent-disk)" }}
                >
                  <HardDrive className="w-3 h-3 shrink-0" />
                  Datenträger
                </span>
                <span
                  className="truncate"
                  style={{ color: "var(--text-secondary)" }}
                >
                  R {formatSpeed(snapshot?.disk.readBytesPerSec ?? 0)} · W{" "}
                  {formatSpeed(snapshot?.disk.writeBytesPerSec ?? 0)}
                </span>
              </div>
            )}

            {hudMetrics.network && (
              <div
                className="px-2.5 py-1.5 rounded-xl border flex flex-col gap-0.5 min-w-0"
                style={{
                  backgroundColor: "var(--bg-surface)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <span
                  className="font-semibold"
                  style={{ color: "var(--accent-net)" }}
                >
                  Netzwerk
                </span>
                <div className="flex items-center gap-2 truncate">
                  <span
                    className="flex items-center gap-0.5 font-medium"
                    style={{ color: "var(--accent-net)" }}
                  >
                    <ArrowDown className="w-2.5 h-2.5" />
                    {formatSpeed(snapshot?.network.rxBytesPerSec ?? 0)}
                  </span>
                  <span
                    className="flex items-center gap-0.5 font-medium"
                    style={{ color: "var(--accent-disk)" }}
                  >
                    <ArrowUp className="w-2.5 h-2.5" />
                    {formatSpeed(snapshot?.network.txBytesPerSec ?? 0)}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Footer: Top Process & Battery */}
        {showFooter && (
          <div
            className="flex items-center justify-between gap-2 text-[11px] tabular-nums px-2.5 py-1.5 rounded-xl border shrink-0"
            style={{
              backgroundColor: "var(--bg-surface)",
              borderColor: "var(--border-subtle)",
            }}
          >
            {hudMetrics.topProcess && topProc ? (
              <div
                className="truncate min-w-0 flex-1"
                style={{ color: "var(--text-secondary)" }}
                title={`Top CPU: ${topProc.name} (${topProc.cpuPercent.toFixed(1)}%)`}
              >
                Top: <span className="font-semibold">{topProc.name}</span>{" "}
                <span style={{ color: "var(--accent-cpu)" }}>
                  {topProc.cpuPercent.toFixed(0)}%
                </span>
              </div>
            ) : (
              <span />
            )}

            {showBattery && snapshot && (
              <span
                className="flex items-center gap-1 font-semibold shrink-0"
                style={{ color: "var(--accent-gpu)" }}
              >
                <BatteryCharging className="w-3.5 h-3.5" />
                {snapshot.battery.percent ?? 0}%
              </span>
            )}
          </div>
        )}
      </div>
    );
  }
);

MiniHud.displayName = "MiniHud";
