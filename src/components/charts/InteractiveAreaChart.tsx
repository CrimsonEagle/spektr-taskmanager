import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { formatTimeShort } from "../../lib/format";
import { HistoryPoint, TimeRange } from "../../types/telemetry";

interface InteractiveAreaChartProps {
  data: HistoryPoint[];
  valueSelector: (p: HistoryPoint) => number;
  color: string;
  unit: string;
  maxValue?: number;
  height?: number;
  selectedRange: TimeRange | null;
  onSelectRange: (range: TimeRange | null) => void;
  onHoverPoint?: (point: HistoryPoint | null) => void;
}

export const InteractiveAreaChart: React.FC<InteractiveAreaChartProps> = ({
  data,
  valueSelector,
  color,
  unit,
  maxValue,
  height = 240,
  selectedRange,
  onSelectRange,
  onHoverPoint,
}) => {
  const uid = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [dragAnchorIdx, setDragAnchorIdx] = useState<number | null>(null);
  const [dragCurrentIdx, setDragCurrentIdx] = useState<number | null>(null);

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

  const clientXToIndex = (clientX: number): number | null => {
    if (!svgRef.current || data.length === 0) return null;
    const rect = svgRef.current.getBoundingClientRect();
    const relX = ((clientX - rect.left) / rect.width) * width;
    const clamped = Math.max(padLeft, Math.min(width - padRight, relX));
    const ratio = (clamped - padLeft) / plotW;
    const idx = Math.round(ratio * (data.length - 1));
    return Math.max(0, Math.min(data.length - 1, idx));
  };

  // Finish drag cleanly even if mouse is released outside SVG
  useEffect(() => {
    if (dragAnchorIdx === null) return;
    const handleWindowUp = () => {
      const a = dragAnchorIdx;
      const b = dragCurrentIdx ?? dragAnchorIdx;
      const startIdx = Math.min(a, b);
      const endIdx = Math.max(a, b);
      const startPt = data[startIdx];
      const endPt = data[endIdx];

      if (startPt && endPt) {
        if (
          startIdx === endIdx &&
          selectedRange &&
          selectedRange.startMs === startPt.timestampMs &&
          selectedRange.endMs === endPt.timestampMs
        ) {
          // Clicking the same pinned single point toggles it off
          onSelectRange(null);
        } else {
          onSelectRange({
            startMs: startPt.timestampMs,
            endMs: endPt.timestampMs,
          });
        }
      }

      setDragAnchorIdx(null);
      setDragCurrentIdx(null);
    };

    window.addEventListener("mouseup", handleWindowUp);
    return () => window.removeEventListener("mouseup", handleWindowUp);
  }, [dragAnchorIdx, dragCurrentIdx, data, selectedRange, onSelectRange]);

  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const idx = clientXToIndex(e.clientX);
    if (idx === null) return;
    setDragAnchorIdx(idx);
    setDragCurrentIdx(idx);
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const idx = clientXToIndex(e.clientX);
    if (idx === null) return;
    setHoverIdx(idx);
    onHoverPoint?.(data[idx] ?? null);
    if (dragAnchorIdx !== null) {
      setDragCurrentIdx(idx);
    }
  };

  const handleMouseLeave = () => {
    setHoverIdx(null);
    onHoverPoint?.(null);
  };

  // Compute visible selection band coordinates (either active drag or pinned selectedRange)
  const selectionBand = useMemo(() => {
    if (data.length === 0) return null;

    if (dragAnchorIdx !== null && dragCurrentIdx !== null) {
      const s = Math.min(dragAnchorIdx, dragCurrentIdx);
      const e = Math.max(dragAnchorIdx, dragCurrentIdx);
      const c1 = coords[s];
      const c2 = coords[e];
      if (!c1 || !c2) return null;
      return {
        startIdx: s,
        endIdx: e,
        x1: c1.x,
        x2: c2.x,
        isDragging: true,
      };
    }

    if (selectedRange) {
      let s = -1;
      let e = -1;
      for (let i = 0; i < data.length; i++) {
        const ts = data[i].timestampMs;
        if (ts >= selectedRange.startMs && ts <= selectedRange.endMs) {
          if (s === -1) s = i;
          e = i;
        }
      }
      if (s === -1 || e === -1) return null;
      const c1 = coords[s];
      const c2 = coords[e];
      if (!c1 || !c2) return null;
      return {
        startIdx: s,
        endIdx: e,
        x1: c1.x,
        x2: c2.x,
        isDragging: false,
      };
    }

    return null;
  }, [data, coords, dragAnchorIdx, dragCurrentIdx, selectedRange]);

  const hoverCoord = hoverIdx != null ? coords[hoverIdx] : null;
  const hoverPoint = hoverIdx != null ? data[hoverIdx] : null;

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

  // Floating pill readout (hovering takes visual readout priority on the chart itself)
  const pillInfo = useMemo(() => {
    if (selectionBand && selectionBand.isDragging) {
      const p1 = data[selectionBand.startIdx];
      const p2 = data[selectionBand.endIdx];
      if (p1 && p2) {
        const span = Math.max(1, selectionBand.endIdx - selectionBand.startIdx + 1);
        return {
          text: `${formatTimeShort(p1.timestampMs)} – ${formatTimeShort(p2.timestampMs)}`,
          sub: `${span}s Bereich`,
          badge: "Ziehen",
        };
      }
    }
    if (hoverPoint && hoverCoord) {
      return {
        text: `${hoverCoord.val.toFixed(1)} ${unit}`,
        sub: `um ${formatTimeShort(hoverPoint.timestampMs)}`,
        badge: null as string | null,
      };
    }
    if (selectionBand) {
      const p1 = data[selectionBand.startIdx];
      const p2 = data[selectionBand.endIdx];
      if (p1 && p2) {
        const span = selectionBand.endIdx - selectionBand.startIdx + 1;
        if (span === 1) {
          const val = coords[selectionBand.startIdx]?.val ?? 0;
          return {
            text: `${val.toFixed(1)} ${unit}`,
            sub: `um ${formatTimeShort(p1.timestampMs)}`,
            badge: "Fixiert",
          };
        }
        return {
          text: `${formatTimeShort(p1.timestampMs)} – ${formatTimeShort(p2.timestampMs)}`,
          sub: `${span}s`,
          badge: "Bereich",
        };
      }
    }
    return null;
  }, [selectionBand, hoverPoint, hoverCoord, data, coords, unit]);

  return (
    <div className="relative w-full select-none">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto cursor-crosshair block"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        <defs>
          <linearGradient id={`area-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.30" />
            <stop offset="85%" stopColor={color} stopOpacity="0.04" />
            <stop offset="100%" stopColor={color} stopOpacity="0.0" />
          </linearGradient>
          <linearGradient id={`band-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.26" />
            <stop offset="100%" stopColor={color} stopOpacity="0.08" />
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

        {/* Selected Range Band (behind curve) */}
        {selectionBand && (
          <g>
            {selectionBand.x2 - selectionBand.x1 >= 2 ? (
              <>
                <rect
                  x={selectionBand.x1}
                  y={padTop}
                  width={selectionBand.x2 - selectionBand.x1}
                  height={plotH}
                  fill={`url(#band-${uid})`}
                  rx="4"
                />
                <line
                  x1={selectionBand.x1}
                  y1={padTop}
                  x2={selectionBand.x1}
                  y2={padTop + plotH}
                  stroke={color}
                  strokeWidth="1.6"
                  opacity="0.9"
                />
                <line
                  x1={selectionBand.x2}
                  y1={padTop}
                  x2={selectionBand.x2}
                  y2={padTop + plotH}
                  stroke={color}
                  strokeWidth="1.6"
                  opacity="0.9"
                />
              </>
            ) : (
              <line
                x1={selectionBand.x1}
                y1={padTop}
                x2={selectionBand.x1}
                y2={padTop + plotH}
                stroke={color}
                strokeWidth="1.6"
                strokeDasharray="3 3"
                opacity="0.9"
              />
            )}
          </g>
        )}

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
          const inSel =
            selectionBand != null &&
            idx >= selectionBand.startIdx &&
            idx <= selectionBand.endIdx;
          return (
            <g key={idx}>
              <circle
                cx={c.x}
                cy={c.y}
                r={inSel ? 6.5 : 4.8}
                fill="rgba(239, 68, 68, 0.24)"
              />
              <circle
                cx={c.x}
                cy={c.y}
                r={inSel ? 3.8 : 2.8}
                fill="#ef4444"
                stroke="var(--bg-surface-solid)"
                strokeWidth="1.4"
              />
            </g>
          );
        })}

        {/* Pinned single-point dot */}
        {selectionBand &&
          selectionBand.startIdx === selectionBand.endIdx &&
          coords[selectionBand.startIdx] && (
            <g>
              <circle
                cx={coords[selectionBand.startIdx].x}
                cy={coords[selectionBand.startIdx].y}
                r="7"
                fill={color}
                opacity="0.24"
              />
              <circle
                cx={coords[selectionBand.startIdx].x}
                cy={coords[selectionBand.startIdx].y}
                r="4"
                fill={color}
                stroke="var(--bg-surface-solid)"
                strokeWidth="2"
              />
            </g>
          )}

        {/* Hover crosshair */}
        {hoverCoord && dragAnchorIdx === null && (
          <g>
            <line
              x1={hoverCoord.x}
              y1={padTop}
              x2={hoverCoord.x}
              y2={padTop + plotH}
              stroke="var(--text-secondary)"
              strokeWidth="1"
              strokeDasharray="3 3"
              opacity="0.55"
            />
            <circle
              cx={hoverCoord.x}
              cy={hoverCoord.y}
              r="3.5"
              fill={color}
              stroke="var(--bg-surface-solid)"
              strokeWidth="1.8"
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
      {pillInfo && (
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
          <span className="font-semibold">{pillInfo.text}</span>
          <span style={{ color: "var(--text-muted)" }}>{pillInfo.sub}</span>
          {pillInfo.badge && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded font-semibold"
              style={{
                backgroundColor: `${color}22`,
                color,
              }}
            >
              {pillInfo.badge}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
