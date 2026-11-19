import React, { useId, useMemo, useRef, useState } from "react";
import { formatTimeShort } from "../../lib/format";
import { HistoryPoint } from "../../types/telemetry";

interface InteractiveAreaChartProps {
  data: HistoryPoint[];
  valueSelector: (p: HistoryPoint) => number;
  color: string;
  unit: string;
  maxValue?: number;
  height?: number;
  selectedIndex: number | null;
  onSelectIndex: (index: number | null) => void;
  onHoverIndex?: (index: number | null) => void;
}

export const InteractiveAreaChart: React.FC<InteractiveAreaChartProps> = ({
  data,
  valueSelector,
  color,
  unit,
  maxValue,
  height = 240,
  selectedIndex,
  onSelectIndex,
  onHoverIndex,
}) => {
  const uid = useId().replace(/:/g, "");
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const width = 920;
  const padLeft = 44;
  const padRight = 14;
  const padTop = 16;
  const padBottom = 26;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const { coords, computedMax, linePath, areaPath, spikes } = useMemo(() => {
    const values = data.map(valueSelector);
    const maxObserved = values.length > 0 ? Math.max(...values) : 0;
    const cMax =
      maxValue != null
        ? maxValue
        : Math.max(10, Math.ceil((maxObserved * 1.2) / 10) * 10);

    if (data.length === 0) {
      return {
        coords: [] as { x: number; y: number; val: number }[],
        computedMax: cMax,
        linePath: "",
        areaPath: "",
        spikes: [] as number[],
      };
    }

    const stepX = data.length > 1 ? plotW / (data.length - 1) : plotW;
    const pts = data.map((pt, i) => {
      const val = valueSelector(pt);
      const x = padLeft + (data.length > 1 ? i * stepX : plotW);
      const norm = Math.max(0, Math.min(1, val / (cMax || 1)));
      const y = padTop + plotH - norm * plotH;
      return { x, y, val };
    });

    let line = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const curr = pts[i];
      const cx = (prev.x + curr.x) / 2;
      line += ` C ${cx.toFixed(1)} ${prev.y.toFixed(1)}, ${cx.toFixed(1)} ${curr.y.toFixed(1)}, ${curr.x.toFixed(1)} ${curr.y.toFixed(1)}`;
    }
    const baseY = padTop + plotH;
    const area = `${line} L ${pts[pts.length - 1].x.toFixed(1)} ${baseY} L ${pts[0].x.toFixed(1)} ${baseY} Z`;

    const spikeIndices: number[] = [];
    data.forEach((pt, i) => {
      if (pt.isSpike) spikeIndices.push(i);
    });

    return {
      coords: pts,
      computedMax: cMax,
      linePath: line,
      areaPath: area,
      spikes: spikeIndices,
    };
  }, [data, valueSelector, maxValue, plotW, plotH]);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (data.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * width;
    const clamped = Math.max(padLeft, Math.min(width - padRight, relX));
    const ratio = (clamped - padLeft) / plotW;
    const idx = Math.round(ratio * (data.length - 1));
    const safeIdx = Math.max(0, Math.min(data.length - 1, idx));
    setHoverIdx(safeIdx);
    onHoverIndex?.(safeIdx);
  };

  const handleMouseLeave = () => {
    setHoverIdx(null);
    onHoverIndex?.(null);
  };

  const handleClick = () => {
    if (hoverIdx != null) {
      onSelectIndex(selectedIndex === hoverIdx ? null : hoverIdx);
    }
  };

  const activeIdx = hoverIdx ?? selectedIndex;
  const activeCoord = activeIdx != null ? coords[activeIdx] : null;
  const activePoint = activeIdx != null ? data[activeIdx] : null;

  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const xLabelIndices = useMemo(() => {
    if (data.length < 2) return [0];
    const count = Math.min(5, data.length);
    const arr: number[] = [];
    for (let i = 0; i < count; i++) {
      arr.push(Math.round((i / (count - 1)) * (data.length - 1)));
    }
    return arr;
  }, [data.length]);

  return (
    <div ref={containerRef} className="relative w-full select-none">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto cursor-crosshair block"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
      >
        <defs>
          <linearGradient id={`area-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.32" />
            <stop offset="85%" stopColor={color} stopOpacity="0.04" />
            <stop offset="100%" stopColor={color} stopOpacity="0.0" />
          </linearGradient>
        </defs>

        {/* Horizontal grid lines */}
        {yTicks.map((t) => {
          const y = padTop + plotH - t * plotH;
          const labelVal = Math.round(computedMax * t);
          return (
            <g key={t}>
              <line
                x1={padLeft}
                y1={y}
                x2={width - padRight}
                y2={y}
                stroke="var(--border-subtle)"
                strokeDasharray={t === 0 ? undefined : "3 4"}
                strokeWidth="1"
              />
              <text
                x={padLeft - 8}
                y={y + 3.5}
                textAnchor="end"
                fontSize="10"
                fill="var(--text-muted)"
                className="tabular-nums"
              >
                {labelVal}
                {unit === "%" ? "%" : ""}
              </text>
            </g>
          );
        })}

        {/* Area & Curve */}
        {areaPath && <path d={areaPath} fill={`url(#area-${uid})`} />}
        {linePath && (
          <path
            d={linePath}
            fill="none"
            stroke={color}
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* Spike markers */}
        {spikes.map((idx) => {
          const c = coords[idx];
          if (!c) return null;
          const isSel = selectedIndex === idx;
          return (
            <g key={idx}>
              <circle
                cx={c.x}
                cy={c.y}
                r={isSel ? 7 : 5}
                fill="rgba(239, 68, 68, 0.22)"
              />
              <circle
                cx={c.x}
                cy={c.y}
                r={isSel ? 4 : 3}
                fill="#ef4444"
                stroke="var(--bg-surface-solid)"
                strokeWidth="1.5"
              />
            </g>
          );
        })}

        {/* Active hover / pinned crosshair */}
        {activeCoord && activePoint && (
          <g>
            <line
              x1={activeCoord.x}
              y1={padTop}
              x2={activeCoord.x}
              y2={padTop + plotH}
              stroke={color}
              strokeWidth="1.25"
              strokeDasharray="3 3"
              opacity="0.8"
            />
            <circle
              cx={activeCoord.x}
              cy={activeCoord.y}
              r="7"
              fill={color}
              opacity="0.22"
            />
            <circle
              cx={activeCoord.x}
              cy={activeCoord.y}
              r="4"
              fill={color}
              stroke="var(--bg-surface-solid)"
              strokeWidth="2"
            />
          </g>
        )}

        {/* X axis timestamps */}
        {data.length > 0 &&
          xLabelIndices.map((idx) => {
            const c = coords[idx];
            const pt = data[idx];
            if (!c || !pt) return null;
            return (
              <text
                key={idx}
                x={c.x}
                y={height - 6}
                textAnchor={
                  idx === 0
                    ? "start"
                    : idx === data.length - 1
                      ? "end"
                      : "middle"
                }
                fontSize="10"
                fill="var(--text-muted)"
                className="tabular-nums"
              >
                {formatTimeShort(pt.timestampMs)}
              </text>
            );
          })}
      </svg>

      {/* Floating readout pill */}
      {activePoint && activeCoord && (
        <div
          className="pointer-events-none absolute top-2 right-3 px-2.5 py-1 rounded-lg text-xs font-medium tabular-nums flex items-center gap-2 border"
          style={{
            backgroundColor: "var(--bg-drawer)",
            borderColor: "var(--border-strong)",
            boxShadow: "var(--shadow-card)",
          }}
        >
          <span
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: color }}
          />
          <span className="font-semibold">
            {activeCoord.val.toFixed(1)} {unit}
          </span>
          <span style={{ color: "var(--text-muted)" }}>
            um {formatTimeShort(activePoint.timestampMs)}
          </span>
          {selectedIndex === activeIdx && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-500 font-semibold">
              Fixiert
            </span>
          )}
        </div>
      )}
    </div>
  );
};
