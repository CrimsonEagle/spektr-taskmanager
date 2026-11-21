import React, { useEffect, useState } from "react";
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
        onMouseDown={handleDrag}
        className="h-11 shrink-0 flex items-center justify-between gap-2 px-3.5 border-b select-none"
        style={{
          backgroundColor: "var(--bg-titlebar)",
          borderColor: "var(--border-subtle)",
        }}
      >
        {/* Left: Brand & Clickable Live Telemetry Pills */}
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex items-center gap-2 shrink-0">
            <SpektrLogo size={24} className="shadow-sm" />
            <span className="font-semibold text-sm tracking-tight">
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

          {snapshot && (
            <div className="hidden lg:flex items-center gap-1.5 ml-1 text-[11px] font-medium tabular-nums shrink-0">
              {titleBarMetrics.cpu && (
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

              {titleBarMetrics.ram && (
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

              {titleBarMetrics.gpu &&
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

              {titleBarMetrics.disk && (
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

              {titleBarMetrics.network && (
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
          className="flex items-center gap-2 px-2.5 py-1 rounded-lg text-xs border transition-colors cursor-pointer min-w-0"
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
        <div className="flex items-center gap-1 shrink-0">
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
