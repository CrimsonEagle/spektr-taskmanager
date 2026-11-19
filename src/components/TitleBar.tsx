import React, { useEffect, useState } from "react";
import {
  Activity,
  Command,
  Maximize2,
  Minimize2,
  Minus,
  Monitor,
  Moon,
  PictureInPicture2,
  Sun,
  X,
} from "lucide-react";
import { api } from "../lib/tauri";
import { TelemetrySnapshot, ThemePreference } from "../types/telemetry";

interface TitleBarProps {
  snapshot: TelemetrySnapshot | null;
  themePreference: ThemePreference;
  onCycleTheme: () => void;
  onOpenPalette: () => void;
  onEnterMiniHud: () => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  snapshot,
  themePreference,
  onCycleTheme,
  onOpenPalette,
  onEnterMiniHud,
}) => {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    api.window.isMaximized().then(setIsMaximized).catch(() => {});
  }, []);

  const handleToggleMax = async () => {
    await api.window.toggleMaximize();
    const max = await api.window.isMaximized();
    setIsMaximized(max);
  };

  const handleDrag = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button, input")) return;
    if (e.detail === 2) {
      handleToggleMax();
    } else {
      api.window.startDragging().catch(() => {});
    }
  };

  const themeIcon =
    themePreference === "system" ? (
      <Monitor className="w-3.5 h-3.5" />
    ) : themePreference === "light" ? (
      <Sun className="w-3.5 h-3.5" />
    ) : (
      <Moon className="w-3.5 h-3.5" />
    );

  const themeLabel =
    themePreference === "system"
      ? "System"
      : themePreference === "light"
        ? "Hell"
        : "Dunkel";

  return (
    <header
      onMouseDown={handleDrag}
      className="h-11 shrink-0 flex items-center justify-between px-3.5 border-b select-none"
      style={{
        backgroundColor: "var(--bg-titlebar)",
        borderColor: "var(--border-subtle)",
      }}
    >
      {/* Left: Brand & Live mini telemetry pills */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg flex items-center justify-center bg-gradient-to-br from-sky-500 via-indigo-500 to-violet-500 text-white shadow-sm">
            <Activity className="w-3.5 h-3.5 stroke-[2.5]" />
          </div>
          <span className="font-semibold text-sm tracking-tight">Pulse</span>
          <span
            className="text-[11px] font-medium hidden sm:inline"
            style={{ color: "var(--text-muted)" }}
          >
            Task Manager
          </span>
        </div>

        {snapshot && (
          <div className="hidden md:flex items-center gap-1.5 ml-2 text-[11px] font-medium tabular-nums">
            <span
              className="px-2 py-0.5 rounded-full flex items-center justify-between gap-1.5 w-[76px] shrink-0"
              style={{
                backgroundColor: "var(--accent-cpu-soft)",
                color: "var(--accent-cpu)",
              }}
            >
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                CPU
              </span>
              <span className="text-right">{snapshot.cpu.totalUsage.toFixed(0)}%</span>
            </span>
            <span
              className="px-2 py-0.5 rounded-full flex items-center justify-between gap-1.5 w-[78px] shrink-0"
              style={{
                backgroundColor: "var(--accent-ram-soft)",
                color: "var(--accent-ram)",
              }}
            >
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                RAM
              </span>
              <span className="text-right">{snapshot.memory.usagePercent.toFixed(0)}%</span>
            </span>
            {snapshot.gpu.available && snapshot.gpu.usagePercent != null && (
              <span
                className="px-2 py-0.5 rounded-full flex items-center justify-between gap-1.5 w-[76px] shrink-0"
                style={{
                  backgroundColor: "var(--accent-gpu-soft)",
                  color: "var(--accent-gpu)",
                }}
              >
                <span className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                  GPU
                </span>
                <span className="text-right">{snapshot.gpu.usagePercent.toFixed(0)}%</span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Center: Quick Command Palette trigger */}
      <button
        onClick={onOpenPalette}
        className="flex items-center gap-2 px-3 py-1 rounded-lg text-xs border transition-colors cursor-pointer"
        style={{
          backgroundColor: "var(--bg-subtle)",
          borderColor: "var(--border-subtle)",
          color: "var(--text-secondary)",
        }}
        title="Befehlspalette öffnen (Strg+K)"
      >
        <Command className="w-3.5 h-3.5 opacity-75" />
        <span className="hidden sm:inline">Prozess, Port (:3000) oder Aktion suchen…</span>
        <kbd
          className="px-1.5 py-0.5 text-[10px] rounded font-mono font-semibold"
          style={{
            backgroundColor: "var(--bg-surface-solid)",
            border: "1px solid var(--border-subtle)",
          }}
        >
          Strg+K
        </kbd>
      </button>

      {/* Right: Theme, Mini-HUD & native window controls */}
      <div className="flex items-center gap-1">
        <button
          onClick={onCycleTheme}
          className="h-7 px-2 rounded-md flex items-center gap-1.5 text-xs font-medium transition-colors cursor-pointer hover:bg-[var(--bg-surface-hover)]"
          style={{ color: "var(--text-secondary)" }}
          title={`Design: ${themeLabel} (klicken zum Wechseln)`}
        >
          {themeIcon}
          <span className="hidden lg:inline">{themeLabel}</span>
        </button>

        <button
          onClick={onEnterMiniHud}
          className="h-7 px-2 rounded-md flex items-center gap-1.5 text-xs font-medium transition-colors cursor-pointer hover:bg-[var(--bg-surface-hover)]"
          style={{ color: "var(--text-secondary)" }}
          title="Kompaktes Always-on-Top Mini-HUD aktivieren"
        >
          <PictureInPicture2 className="w-3.5 h-3.5" />
          <span className="hidden lg:inline">HUD</span>
        </button>

        <div
          className="w-px h-4 mx-1"
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
};
