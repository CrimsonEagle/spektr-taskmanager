import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsInSimple as Minimize2,
  ArrowsOutSimple as Maximize2,
  Command,
  Crosshair,
  GearSix as Settings,
  Minus,
  Pause,
  PictureInPicture as PictureInPicture2,
  Play,
  Shield,
  ShieldCheck,
  X,
} from "@phosphor-icons/react";
import { TitleBarMetricsConfig } from "../hooks/useSettings";
import { useI18n } from "../i18n";
import { formatSpeed } from "../lib/format";
import { api } from "../lib/tauri";
import { PerformanceMetric, TelemetrySnapshot } from "../types/telemetry";
import { SpektrLogo } from "./SpektrLogo";

type PillKey = keyof TitleBarMetricsConfig;

const PILL_ORDER: PillKey[] = ["cpu", "ram", "gpu", "disk", "network"];
const PILL_WIDTHS: Record<PillKey, number> = {
  cpu: 78,
  ram: 80,
  gpu: 78,
  disk: 114,
  network: 116,
};
const PILL_GAP = 6; // gap-1.5
// Reserve enough space for the centered Command Palette button + padding/gaps so pills never collide with it.
const RESERVED_PALETTE_AND_CHROME = 248 + 28 + 16 + 14 + 10;

interface TitleBarProps {
  snapshot: TelemetrySnapshot | null;
  telemetryPaused: boolean;
  isElevated: boolean | null;
  pickingWindow: boolean;
  titleBarMetrics: TitleBarMetricsConfig;
  closeToTray: boolean;
  minimizeToTrayOnMinimize: boolean;
  onTogglePause: () => void;
  onRestartAsAdmin: () => void;
  onPickWindow: () => void;
  onOpenSettings: () => void;
  onSelectPerformanceMetric: (metric: PerformanceMetric) => void;
  onOpenPalette: () => void;
  onEnterMiniHud: () => void;
}

export const TitleBar: React.FC<TitleBarProps> = React.memo(
  ({
    snapshot,
    telemetryPaused,
    isElevated,
    pickingWindow,
    titleBarMetrics,
    closeToTray,
    minimizeToTrayOnMinimize,
    onTogglePause,
    onRestartAsAdmin,
    onPickWindow,
    onOpenSettings,
    onSelectPerformanceMetric,
    onOpenPalette,
    onEnterMiniHud,
  }) => {
    const { t } = useI18n();
    const [isMaximized, setIsMaximized] = useState(false);
    const headerRef = useRef<HTMLElement>(null);
    const brandRef = useRef<HTMLDivElement>(null);
    const rightRef = useRef<HTMLDivElement>(null);
    const [availablePillsWidth, setAvailablePillsWidth] = useState<number>(600);

    useEffect(() => {
      const recalc = () => {
        const headerEl = headerRef.current;
        const brandEl = brandRef.current;
        const rightEl = rightRef.current;
        if (!headerEl || !brandEl || !rightEl) return;
        const avail =
          headerEl.clientWidth -
          brandEl.offsetWidth -
          rightEl.offsetWidth -
          RESERVED_PALETTE_AND_CHROME;
        setAvailablePillsWidth((prev) =>
          Math.abs(prev - avail) >= 2 ? avail : prev
        );
      };

      recalc();
      const ro = new ResizeObserver(recalc);
      if (headerRef.current) ro.observe(headerRef.current);
      if (brandRef.current) ro.observe(brandRef.current);
      if (rightRef.current) ro.observe(rightRef.current);
      return () => ro.disconnect();
    }, [isElevated, telemetryPaused]);

    const visiblePills = useMemo(() => {
      const shown = new Set<PillKey>();
      if (!snapshot || availablePillsWidth <= 0) return shown;

      const gpuReady = Boolean(
        snapshot.gpu.available && snapshot.gpu.usagePercent != null
      );
      let used = 0;
      for (const key of PILL_ORDER) {
        if (!titleBarMetrics[key]) continue;
        if (key === "gpu" && !gpuReady) continue;
        const needed = (used > 0 ? PILL_GAP : 0) + PILL_WIDTHS[key];
        if (used + needed <= availablePillsWidth) {
          shown.add(key);
          used += needed;
        } else {
          break;
        }
      }
      return shown;
    }, [
      snapshot?.gpu.available,
      snapshot?.gpu.usagePercent != null,
      Boolean(snapshot),
      titleBarMetrics,
      availablePillsWidth,
    ]);

    useEffect(() => {
      let mounted = true;
      let unlisten: (() => void) | null = null;

      const syncMaximized = () => {
        api.window
          .isMaximized()
          .then((max) => {
            if (mounted) setIsMaximized(max);
          })
          .catch(() => {});
      };

      syncMaximized();
      api.window
        .onResized(syncMaximized)
        .then((fn) => {
          if (mounted) unlisten = fn;
          else fn();
        })
        .catch(() => {});

      return () => {
        mounted = false;
        if (unlisten) unlisten();
      };
    }, []);

    const handleToggleMax = async () => {
      await api.window.toggleMaximize();
      const max = await api.window.isMaximized();
      setIsMaximized(max);
    };

    const handleDrag = (e: React.MouseEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest("button, input, select")) return;
      if (e.detail === 2) {
        handleToggleMax();
      } else {
        api.window.startDragging().catch(() => {});
      }
    };

    return (
      <header
        ref={headerRef}
        onMouseDown={handleDrag}
        className="h-11 shrink-0 flex items-center justify-between gap-2 px-3.5 border-b select-none overflow-hidden"
        style={{
          backgroundColor: "var(--bg-titlebar)",
          borderColor: "var(--border-subtle)",
        }}
      >
        {/* Left: Brand & Clickable Live Telemetry Pills */}
        <div className="flex items-center gap-2.5 min-w-0 overflow-hidden">
          <div ref={brandRef} className="flex items-center gap-2.5 shrink-0">
            <div className="flex items-center gap-2 shrink-0">
              <SpektrLogo size={24} className="shadow-sm" />
              <span className="font-semibold text-sm tracking-tight whitespace-nowrap">
                Spektr Taskmanager
              </span>
            </div>

            {isElevated === true && (
              <span
                className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold shrink-0"
                style={{
                  backgroundColor: "var(--accent-gpu-soft)",
                  color: "var(--accent-gpu)",
                  border: "1px solid rgba(16, 185, 129, 0.25)",
                }}
                title={t("app.adminActiveTitle")}
              >
                <ShieldCheck className="w-3 h-3" />
                {t("app.admin")}
              </span>
            )}
            {isElevated === false && (
              <button
                onClick={onRestartAsAdmin}
                className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold cursor-pointer transition-colors hover:bg-[var(--bg-surface-hover)] shrink-0 border"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-subtle)",
                  color: "var(--text-secondary)",
                }}
                title={t("app.adminRestartTitle")}
              >
                <Shield className="w-3 h-3" />
                {t("app.admin")}
              </button>
            )}
          </div>

          {snapshot && visiblePills.size > 0 && (
            <div className="flex items-center gap-1.5 ml-1 text-[11px] font-medium tabular-nums shrink-0">
              {visiblePills.has("cpu") && (
                <button
                  onClick={() => onSelectPerformanceMetric("cpu")}
                  className="px-2 py-0.5 rounded-full flex items-center justify-between gap-1.5 w-[78px] shrink-0 whitespace-nowrap cursor-pointer transition-opacity hover:opacity-85"
                  style={{
                    backgroundColor: "var(--accent-cpu-soft)",
                    color: "var(--accent-cpu)",
                  }}
                  title={t("titlebar.cpuTooltip")}
                >
                  <span className="flex items-center gap-1 shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                    CPU
                  </span>
                  <span className="text-right whitespace-nowrap">
                    {snapshot.cpu.totalUsage.toFixed(0)}%
                  </span>
                </button>
              )}

              {visiblePills.has("ram") && (
                <button
                  onClick={() => onSelectPerformanceMetric("memory")}
                  className="px-2 py-0.5 rounded-full flex items-center justify-between gap-1.5 w-[80px] shrink-0 whitespace-nowrap cursor-pointer transition-opacity hover:opacity-85"
                  style={{
                    backgroundColor: "var(--accent-ram-soft)",
                    color: "var(--accent-ram)",
                  }}
                  title={t("titlebar.ramTooltip")}
                >
                  <span className="flex items-center gap-1 shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                    RAM
                  </span>
                  <span className="text-right whitespace-nowrap">
                    {snapshot.memory.usagePercent.toFixed(0)}%
                  </span>
                </button>
              )}

              {visiblePills.has("gpu") &&
                snapshot.gpu.available &&
                snapshot.gpu.usagePercent != null && (
                  <button
                    onClick={() => onSelectPerformanceMetric("gpu")}
                    className="px-2 py-0.5 rounded-full flex items-center justify-between gap-1.5 w-[78px] shrink-0 whitespace-nowrap cursor-pointer transition-opacity hover:opacity-85"
                    style={{
                      backgroundColor: "var(--accent-gpu-soft)",
                      color: "var(--accent-gpu)",
                    }}
                    title={t("titlebar.gpuTooltip")}
                  >
                    <span className="flex items-center gap-1 shrink-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                      GPU
                    </span>
                    <span className="text-right whitespace-nowrap">
                      {snapshot.gpu.usagePercent.toFixed(0)}%
                    </span>
                  </button>
                )}

              {visiblePills.has("disk") && (
                <button
                  onClick={() => onSelectPerformanceMetric("disk")}
                  className="px-2 py-0.5 rounded-full flex items-center justify-between gap-1.5 w-[114px] shrink-0 whitespace-nowrap cursor-pointer transition-opacity hover:opacity-85"
                  style={{
                    backgroundColor: "var(--accent-disk-soft)",
                    color: "var(--accent-disk)",
                  }}
                  title={t("titlebar.diskTooltip")}
                >
                  <span className="flex items-center gap-1 shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                    {t("titlebar.disk")}
                  </span>
                  <span className="text-right whitespace-nowrap">
                    {formatSpeed(
                      snapshot.disk.readBytesPerSec +
                        snapshot.disk.writeBytesPerSec
                    )}
                  </span>
                </button>
              )}

              {visiblePills.has("network") && (
                <button
                  onClick={() => onSelectPerformanceMetric("network")}
                  className="px-2 py-0.5 rounded-full flex items-center justify-between gap-1.5 w-[116px] shrink-0 whitespace-nowrap cursor-pointer transition-opacity hover:opacity-85"
                  style={{
                    backgroundColor: "var(--accent-net-soft)",
                    color: "var(--accent-net)",
                  }}
                  title={t("titlebar.netTooltip")}
                >
                  <span className="flex items-center gap-1 shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                    {t("titlebar.net")}
                  </span>
                  <span className="text-right whitespace-nowrap">
                    {formatSpeed(
                      snapshot.network.rxBytesPerSec +
                        snapshot.network.txBytesPerSec
                    )}
                  </span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Center: Quick Command Palette trigger */}
        <button
          onClick={onOpenPalette}
          className="flex items-center gap-2 px-2.5 py-1 rounded-lg text-xs border transition-colors cursor-pointer min-w-0 max-w-[300px]"
          style={{
            backgroundColor: "var(--bg-subtle)",
            borderColor: "var(--border-subtle)",
            color: "var(--text-secondary)",
          }}
          title={t("titlebar.paletteTooltip")}
        >
          <Command className="w-3.5 h-3.5 opacity-75 shrink-0" />
          <span className="hidden md:inline truncate">
            {t("titlebar.palettePlaceholder")}
          </span>
          <kbd
            className="px-1.5 py-0.5 text-[10px] rounded font-mono font-semibold shrink-0"
            style={{
              backgroundColor: "var(--bg-surface-solid)",
              border: "1px solid var(--border-subtle)",
            }}
          >
            {t("titlebar.shortcutPalette")}
          </kbd>
        </button>

        {/* Right: Pause, Picker, Settings, Mini-HUD & native window controls */}
        <div ref={rightRef} className="flex items-center gap-1 shrink-0">
          {/* Pause / Resume */}
          <button
            onClick={onTogglePause}
            className="h-7 px-2 rounded-md border flex items-center gap-1 text-[11px] font-semibold cursor-pointer transition-colors hover:bg-[var(--bg-surface-hover)]"
            style={{
              backgroundColor: telemetryPaused
                ? "var(--accent-disk-soft)"
                : "var(--bg-subtle)",
              borderColor: telemetryPaused
                ? "var(--accent-disk)"
                : "var(--border-subtle)",
              color: telemetryPaused
                ? "var(--accent-disk)"
                : "var(--text-secondary)",
            }}
            title={
              telemetryPaused
                ? t("titlebar.resumeTooltip")
                : t("titlebar.pauseTooltip")
            }
          >
            {telemetryPaused ? (
              <>
                <Play className="w-3 h-3" />
                <span className="hidden sm:inline">{t("titlebar.paused")}</span>
              </>
            ) : (
              <Pause className="w-3 h-3" />
            )}
          </button>

          {/* Window Picker Crosshair */}
          <button
            onClick={onPickWindow}
            className="h-7 w-7 rounded-md flex items-center justify-center transition-colors cursor-pointer hover:bg-[var(--bg-surface-hover)]"
            style={{
              backgroundColor: pickingWindow
                ? "var(--accent-cpu-soft)"
                : "transparent",
              color: pickingWindow
                ? "var(--accent-cpu)"
                : "var(--text-secondary)",
            }}
            title={t("titlebar.pickerTooltip")}
          >
            <Crosshair className="w-3.5 h-3.5" />
          </button>

          {/* Settings Modal trigger */}
          <button
            onClick={onOpenSettings}
            className="h-7 w-7 rounded-md flex items-center justify-center transition-colors cursor-pointer hover:bg-[var(--bg-surface-hover)]"
            style={{ color: "var(--text-secondary)" }}
            title={t("titlebar.settings")}
          >
            <Settings className="w-3.5 h-3.5" />
          </button>

          {/* Mini-HUD */}
          <button
            onClick={onEnterMiniHud}
            className="h-7 px-2 rounded-md flex items-center gap-1.5 text-xs font-medium transition-colors cursor-pointer hover:bg-[var(--bg-surface-hover)]"
            style={{ color: "var(--text-secondary)" }}
            title={t("titlebar.hudTooltip")}
          >
            <PictureInPicture2 className="w-3.5 h-3.5" />
            <span className="hidden xl:inline">HUD</span>
          </button>

          <div
            className="w-px h-4 mx-0.5"
            style={{ backgroundColor: "var(--border-subtle)" }}
          />

          <button
            onClick={() => api.minimizeWindow()}
            className="w-8 h-7 rounded-md flex items-center justify-center transition-colors cursor-pointer hover:bg-[var(--bg-surface-hover)]"
            style={{ color: "var(--text-secondary)" }}
            title={
              minimizeToTrayOnMinimize
                ? t("titlebar.minimizeToTray")
                : t("titlebar.minimize")
            }
          >
            <Minus weight="bold" className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleToggleMax}
            className="w-8 h-7 rounded-md flex items-center justify-center transition-colors cursor-pointer hover:bg-[var(--bg-surface-hover)]"
            style={{ color: "var(--text-secondary)" }}
            title={isMaximized ? t("titlebar.restore") : t("titlebar.maximize")}
          >
            {isMaximized ? (
              <Minimize2 weight="bold" className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 weight="bold" className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            onClick={() => api.window.close()}
            className="w-8 h-7 rounded-md flex items-center justify-center transition-colors cursor-pointer hover:bg-red-500 hover:text-white"
            style={{ color: "var(--text-secondary)" }}
            title={closeToTray ? t("titlebar.closeToTray") : t("titlebar.close")}
          >
            <X weight="bold" className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>
    );
  }
);

TitleBar.displayName = "TitleBar";
