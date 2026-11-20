import React, { useEffect, useState } from "react";
import {
  Activity,
  Command,
  Crosshair,
  Maximize2,
  Minimize2,
  Minus,
  Pause,
  PictureInPicture2,
  Play,
  Settings,
  Shield,
  ShieldCheck,
  X,
} from "lucide-react";
import { TitleBarMetricsConfig } from "../hooks/useSettings";
import { formatSpeed } from "../lib/format";
import { api } from "../lib/tauri";
import { PerformanceMetric, TelemetrySnapshot } from "../types/telemetry";

interface TitleBarProps {
  snapshot: TelemetrySnapshot | null;
  telemetryPaused: boolean;
  isElevated: boolean | null;
  pickingWindow: boolean;
  titleBarMetrics: TitleBarMetricsConfig;
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
    onTogglePause,
    onRestartAsAdmin,
    onPickWindow,
    onOpenSettings,
    onSelectPerformanceMetric,
    onOpenPalette,
    onEnterMiniHud,
  }) => {
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
            <div className="w-6 h-6 rounded-lg flex items-center justify-center bg-gradient-to-br from-sky-500 via-indigo-500 to-violet-500 text-white shadow-sm">
              <Activity className="w-3.5 h-3.5 stroke-[2.5]" />
            </div>
            <span className="font-semibold text-sm tracking-tight">
              Pulse Taskmanager
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
              title="Läuft mit Administratorrechten"
            >
              <ShieldCheck className="w-3 h-3" />
              Admin
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
              title="Als Administrator neu starten"
            >
              <Shield className="w-3 h-3" />
              Admin
            </button>
          )}

          {snapshot && (
            <div className="hidden lg:flex items-center gap-1.5 ml-1 text-[11px] font-medium tabular-nums overflow-hidden">
              {titleBarMetrics.cpu && (
                <button
                  onClick={() => onSelectPerformanceMetric("cpu")}
                  className="px-2 py-0.5 rounded-full flex items-center justify-between gap-1.5 min-w-[74px] shrink-0 cursor-pointer transition-opacity hover:opacity-85"
                  style={{
                    backgroundColor: "var(--accent-cpu-soft)",
                    color: "var(--accent-cpu)",
                  }}
                  title="CPU-Details in Performance öffnen"
                >
                  <span className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                    CPU
                  </span>
                  <span className="text-right">
                    {snapshot.cpu.totalUsage.toFixed(0)}%
                  </span>
                </button>
              )}

              {titleBarMetrics.ram && (
                <button
                  onClick={() => onSelectPerformanceMetric("memory")}
                  className="px-2 py-0.5 rounded-full flex items-center justify-between gap-1.5 min-w-[76px] shrink-0 cursor-pointer transition-opacity hover:opacity-85"
                  style={{
                    backgroundColor: "var(--accent-ram-soft)",
                    color: "var(--accent-ram)",
                  }}
                  title="RAM-Details in Performance öffnen"
                >
                  <span className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                    RAM
                  </span>
                  <span className="text-right">
                    {snapshot.memory.usagePercent.toFixed(0)}%
                  </span>
                </button>
              )}

              {titleBarMetrics.gpu &&
                snapshot.gpu.available &&
                snapshot.gpu.usagePercent != null && (
                  <button
                    onClick={() => onSelectPerformanceMetric("gpu")}
                    className="px-2 py-0.5 rounded-full flex items-center justify-between gap-1.5 min-w-[74px] shrink-0 cursor-pointer transition-opacity hover:opacity-85"
                    style={{
                      backgroundColor: "var(--accent-gpu-soft)",
                      color: "var(--accent-gpu)",
                    }}
                    title="GPU-Details in Performance öffnen"
                  >
                    <span className="flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                      GPU
                    </span>
                    <span className="text-right">
                      {snapshot.gpu.usagePercent.toFixed(0)}%
                    </span>
                  </button>
                )}

              {titleBarMetrics.disk && (
                <button
                  onClick={() => onSelectPerformanceMetric("disk")}
                  className="px-2 py-0.5 rounded-full flex items-center justify-between gap-1.5 shrink-0 cursor-pointer transition-opacity hover:opacity-85"
                  style={{
                    backgroundColor: "var(--accent-disk-soft)",
                    color: "var(--accent-disk)",
                  }}
                  title="Datenträger-Details in Performance öffnen"
                >
                  <span className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                    Disk
                  </span>
                  <span>
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
                  className="px-2 py-0.5 rounded-full flex items-center justify-between gap-1.5 shrink-0 cursor-pointer transition-opacity hover:opacity-85"
                  style={{
                    backgroundColor: "var(--accent-net-soft)",
                    color: "var(--accent-net)",
                  }}
                  title="Netzwerk-Details in Performance öffnen"
                >
                  <span className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                    Netz
                  </span>
                  <span>
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
          title="Befehlspalette öffnen (Strg+K) · Aufgabe ausführen (Strg+R)"
        >
          <Command className="w-3.5 h-3.5 opacity-75 shrink-0" />
          <span className="hidden md:inline truncate">
            Prozess, Port (:3000) oder Aktion…
          </span>
          <kbd
            className="px-1.5 py-0.5 text-[10px] rounded font-mono font-semibold shrink-0"
            style={{
              backgroundColor: "var(--bg-surface-solid)",
              border: "1px solid var(--border-subtle)",
            }}
          >
            Strg+K
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
                ? "Telemetrie fortsetzen (Leertaste)"
                : "Telemetrie pausieren (Leertaste)"
            }
          >
            {telemetryPaused ? (
              <>
                <Play className="w-3 h-3" />
                <span className="hidden sm:inline">Pausiert</span>
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
            title="Fenster-Picker: Klicke auf ein Fenster, um dessen Prozess zu inspizieren"
          >
            <Crosshair className="w-3.5 h-3.5" />
          </button>

          {/* Settings Modal trigger */}
          <button
            onClick={onOpenSettings}
            className="h-7 w-7 rounded-md flex items-center justify-center transition-colors cursor-pointer hover:bg-[var(--bg-surface-hover)]"
            style={{ color: "var(--text-secondary)" }}
            title="Einstellungen"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>

          {/* Mini-HUD */}
          <button
            onClick={onEnterMiniHud}
            className="h-7 px-2 rounded-md flex items-center gap-1.5 text-xs font-medium transition-colors cursor-pointer hover:bg-[var(--bg-surface-hover)]"
            style={{ color: "var(--text-secondary)" }}
            title="Kompaktes Always-on-Top Mini-HUD aktivieren"
          >
            <PictureInPicture2 className="w-3.5 h-3.5" />
            <span className="hidden xl:inline">HUD</span>
          </button>

          <div
            className="w-px h-4 mx-0.5"
            style={{ backgroundColor: "var(--border-subtle)" }}
          />

          <button
            onClick={() => api.window.minimize()}
            className="w-8 h-7 rounded-md flex items-center justify-center transition-colors cursor-pointer hover:bg-[var(--bg-surface-hover)]"
            style={{ color: "var(--text-secondary)" }}
            title="Minimieren"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleToggleMax}
            className="w-8 h-7 rounded-md flex items-center justify-center transition-colors cursor-pointer hover:bg-[var(--bg-surface-hover)]"
            style={{ color: "var(--text-secondary)" }}
            title={isMaximized ? "Verkleinern" : "Maximieren"}
          >
            {isMaximized ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            onClick={() => api.window.close()}
            className="w-8 h-7 rounded-md flex items-center justify-center transition-colors cursor-pointer hover:bg-red-500 hover:text-white"
            style={{ color: "var(--text-secondary)" }}
            title="Schließen"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>
    );
  }
);

TitleBar.displayName = "TitleBar";
