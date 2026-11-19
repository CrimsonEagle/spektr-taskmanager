import React from "react";
import { Activity, ArrowDown, ArrowUp, Maximize2, X } from "lucide-react";
import { formatSpeed } from "../lib/format";
import { api } from "../lib/tauri";
import { TelemetrySnapshot } from "../types/telemetry";

interface MiniHudProps {
  snapshot: TelemetrySnapshot | null;
  onExitMiniHud: () => void;
}

export const MiniHud: React.FC<MiniHudProps> = ({ snapshot, onExitMiniHud }) => {
  const handleDrag = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    api.window.startDragging().catch(() => {});
  };

  const cpu = snapshot?.cpu.totalUsage ?? 0;
  const ram = snapshot?.memory.usagePercent ?? 0;
  const gpu = snapshot?.gpu.usagePercent ?? 0;
  const topProc = snapshot?.latestPoint.topCpu[0];

  const gauges = [
    { label: "CPU", value: cpu, color: "var(--accent-cpu)" },
    { label: "RAM", value: ram, color: "var(--accent-ram)" },
    {
      label: "GPU",
      value: snapshot?.gpu.available ? gpu : 0,
      color: "var(--accent-gpu)",
    },
  ];

  return (
    <div
      onMouseDown={handleDrag}
      className="h-full w-full mica-canvas flex flex-col justify-between p-3 select-none border"
      style={{ borderColor: "var(--border-strong)" }}
    >
      {/* Top Bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <div className="w-5 h-5 rounded-md flex items-center justify-center bg-gradient-to-br from-sky-500 via-indigo-500 to-violet-500 text-white">
            <Activity className="w-3 h-3" />
          </div>
          <span className="text-xs font-semibold">Pulse HUD</span>
        </div>

        <div className="flex items-center gap-1">
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
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Live Bars */}
      <div className="grid grid-cols-3 gap-2 my-1">
        {gauges.map((g) => (
          <div
            key={g.label}
            className="p-2 rounded-xl border"
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
              className="h-1.5 w-full rounded-full mt-1.5 overflow-hidden"
              style={{ backgroundColor: "var(--bg-subtle)" }}
            >
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${Math.min(100, Math.max(2, g.value))}%`,
                  backgroundColor: g.color,
                }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Bottom: Network & Top Process */}
      <div className="flex items-center justify-between text-[11px] tabular-nums">
        <div className="flex items-center gap-2.5">
          <span
            className="flex items-center gap-0.5 font-medium"
            style={{ color: "var(--accent-net)" }}
          >
            <ArrowDown className="w-3 h-3" />
            {formatSpeed(snapshot?.network.rxBytesPerSec ?? 0)}
          </span>
          <span
            className="flex items-center gap-0.5 font-medium"
            style={{ color: "var(--accent-disk)" }}
          >
            <ArrowUp className="w-3 h-3" />
            {formatSpeed(snapshot?.network.txBytesPerSec ?? 0)}
          </span>
        </div>

        {topProc && (
          <div
            className="truncate max-w-[155px] text-right"
            style={{ color: "var(--text-secondary)" }}
            title={`Top CPU: ${topProc.name} (${topProc.cpuPercent.toFixed(1)}%)`}
          >
            Top: <span className="font-semibold">{topProc.name}</span>{" "}
            {topProc.cpuPercent.toFixed(0)}%
          </div>
        )}
      </div>
    </div>
  );
};
