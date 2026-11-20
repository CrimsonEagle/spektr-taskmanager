import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
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

const MAX_RENDER_POINTS = 300;

interface DownsampledEntry {
  point: HistoryPoint;
  val: number;
}

/**
 * Downsamples large time series (> MAX_RENDER_POINTS) using min/max bucket decimation
 * while preserving spike points so peaks and anomalies remain visible.
 */
function downsampleHistory(
  data: HistoryPoint[],
  valueSelector: (p: HistoryPoint) => number
): DownsampledEntry[] {
  const len = data.length;
  if (len <= MAX_RENDER_POINTS) {
    const out: DownsampledEntry[] = new Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = { point: data[i], val: valueSelector(data[i]) };
    }
    return out;
  }

  // Reserve ~150 buckets with up to 2 points each (min + max, or spike) -> <= 300 pts
  const bucketCount = Math.floor((MAX_RENDER_POINTS - 2) / 2);
  const bucketSize = (len - 2) / bucketCount;
  const out: DownsampledEntry[] = [];

  out.push({ point: data[0], val: valueSelector(data[0]) });

  for (let b = 0; b < bucketCount; b++) {
    const start = Math.floor(1 + b * bucketSize);
    const end = Math.min(len - 1, Math.floor(1 + (b + 1) * bucketSize));
    if (start >= end) continue;

    let minIdx = start;
    let maxIdx = start;
    let minVal = valueSelector(data[start]);
    let maxVal = minVal;
    let spikeIdx = -1;

    for (let i = start; i < end; i++) {
      const pt = data[i];
      const v = valueSelector(pt);
      if (v < minVal) {
        minVal = v;
        minIdx = i;
      }
      if (v > maxVal) {
        maxVal = v;
        maxIdx = i;
      }
      if (pt.isSpike && spikeIdx === -1) {
        spikeIdx = i;
      }
    }

    if (spikeIdx !== -1 && spikeIdx !== maxIdx && spikeIdx !== minIdx) {
      maxIdx = spikeIdx;
      maxVal = valueSelector(data[spikeIdx]);
    }

    if (minIdx === maxIdx) {
      out.push({ point: data[minIdx], val: minVal });
    } else if (minIdx < maxIdx) {
      out.push({ point: data[minIdx], val: minVal });
      out.push({ point: data[maxIdx], val: maxVal });
    } else {
      out.push({ point: data[maxIdx], val: maxVal });
      out.push({ point: data[minIdx], val: minVal });
    }
  }

  out.push({ point: data[len - 1], val: valueSelector(data[len - 1]) });
  return out;
}

export const InteractiveAreaChart: React.FC<InteractiveAreaChartProps> =
  React.memo(
    ({
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
      const cachedRectRef = useRef<{ left: number; width: number } | null>(null);
      const rafIdRef = useRef<number | null>(null);
      const pendingClientXRef = useRef<number | null>(null);

      const [hoverIdx, setHoverIdx] = useState<number | null>(null);
      const [dragAnchorIdx, setDragAnchorIdx] = useState<number | null>(null);
      const [dragCurrentIdx, setDragCurrentIdx] = useState<number | null>(null);
      const [chartWidth, setChartWidth] = useState<number>(920);

      const width = chartWidth;
      const padLeft = 44;
      const padRight = 14;
      const padTop = 16;
      const padBottom = 26;
      const plotW = Math.max(100, width - padLeft - padRight);
      const plotH = Math.max(60, height - padTop - padBottom);

      const updateCachedRect = useCallback(() => {
        if (!svgRef.current) return;
        const rect = svgRef.current.getBoundingClientRect();
        if (rect.width > 0) {
          cachedRectRef.current = { left: rect.left, width: rect.width };
          const nextW = Math.max(320, Math.round(rect.width));
          setChartWidth((prev) => (Math.abs(prev - nextW) >= 2 ? nextW : prev));
        }
      }, []);

      // Cache SVG bounding rect via ResizeObserver instead of reading layout on every mousemove
      useEffect(() => {
        const el = svgRef.current;
        if (!el) return;
        updateCachedRect();
        const ro = new ResizeObserver(() => updateCachedRect());
        ro.observe(el);
        return () => ro.disconnect();
      }, [updateCachedRect]);

      useEffect(() => {
        return () => {
          if (rafIdRef.current !== null) {
            window.cancelAnimationFrame(rafIdRef.current);
          }
        };
      }, []);

      const {
        entries,
        coords,
        computedMax,
        polylinePoints,
        areaPath,
        spikes,
      } = useMemo(() => {
        const sampled = downsampleHistory(data, valueSelector);
        let maxObserved = 0;
        for (let i = 0; i < sampled.length; i++) {
          if (sampled[i].val > maxObserved) maxObserved = sampled[i].val;
        }
        const cMax =
          maxValue != null
            ? maxValue
            : Math.max(10, Math.ceil((maxObserved * 1.2) / 10) * 10);

        if (sampled.length === 0) {
          return {
            entries: [] as DownsampledEntry[],
            coords: [] as { x: number; y: number; val: number }[],
            computedMax: cMax,
            polylinePoints: "",
            areaPath: "",
            spikes: [] as number[],
          };
        }

        const denom = cMax || 1;
        const stepX = sampled.length > 1 ? plotW / (sampled.length - 1) : plotW;
        const pts: { x: number; y: number; val: number }[] = new Array(
          sampled.length
        );
        const polyParts: string[] = new Array(sampled.length);
        const lineParts: string[] = new Array(sampled.length);
        const spikeIndices: number[] = [];

        for (let i = 0; i < sampled.length; i++) {
          const entry = sampled[i];
          const x = padLeft + (sampled.length > 1 ? i * stepX : plotW);
          const norm =
            entry.val <= 0 ? 0 : entry.val >= denom ? 1 : entry.val / denom;
          const y = padTop + plotH - norm * plotH;
          pts[i] = { x, y, val: entry.val };
          const sx = x.toFixed(1);
          const sy = y.toFixed(1);
          polyParts[i] = `${sx},${sy}`;
          lineParts[i] = i === 0 ? `M ${sx} ${sy}` : `L ${sx} ${sy}`;
          if (entry.point.isSpike) spikeIndices.push(i);
        }

        const baseY = padTop + plotH;
        const last = pts[pts.length - 1];
        const first = pts[0];
        const area = `${lineParts.join(" ")} L ${last.x.toFixed(1)} ${baseY} L ${first.x.toFixed(1)} ${baseY} Z`;

        return {
          entries: sampled,
          coords: pts,
          computedMax: cMax,
          polylinePoints: polyParts.join(" "),
          areaPath: area,
          spikes: spikeIndices,
        };
      }, [data, valueSelector, maxValue, plotW, plotH]);

      const clientXToIndex = useCallback(
        (clientX: number): number | null => {
          if (entries.length === 0) return null;
          let rect = cachedRectRef.current;
          if (!rect && svgRef.current) {
            const r = svgRef.current.getBoundingClientRect();
            rect = { left: r.left, width: r.width };
            cachedRectRef.current = rect;
          }
          if (!rect || rect.width <= 0) return null;
          const relX = ((clientX - rect.left) / rect.width) * width;
          const clamped = Math.max(padLeft, Math.min(width - padRight, relX));
          const ratio = (clamped - padLeft) / plotW;
          const idx = Math.round(ratio * (entries.length - 1));
          return Math.max(0, Math.min(entries.length - 1, idx));
        },
        [entries.length, plotW, width]
      );

      // Finish drag cleanly even if mouse is released outside SVG
      useEffect(() => {
        if (dragAnchorIdx === null) return;
        const handleWindowUp = () => {
          const a = dragAnchorIdx;
          const b = dragCurrentIdx ?? dragAnchorIdx;
          const startIdx = Math.min(a, b);
          const endIdx = Math.max(a, b);
          const startPt = entries[startIdx]?.point;
          const endPt = entries[endIdx]?.point;

          if (startPt && endPt) {
            if (
              startIdx === endIdx &&
              selectedRange &&
              selectedRange.startMs === startPt.timestampMs &&
              selectedRange.endMs === endPt.timestampMs
            ) {
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
      }, [dragAnchorIdx, dragCurrentIdx, entries, selectedRange, onSelectRange]);

      const handleMouseEnter = () => {
        updateCachedRect();
      };

      const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
        if (e.button !== 0) return;
        updateCachedRect();
        const idx = clientXToIndex(e.clientX);
        if (idx === null) return;
        setDragAnchorIdx(idx);
        setDragCurrentIdx(idx);
      };

      const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
        pendingClientXRef.current = e.clientX;
        if (rafIdRef.current !== null) return;

        rafIdRef.current = window.requestAnimationFrame(() => {
          rafIdRef.current = null;
          const cx = pendingClientXRef.current;
          if (cx === null) return;
          const idx = clientXToIndex(cx);
          if (idx === null) return;
          setHoverIdx((prev) => (prev === idx ? prev : idx));
          onHoverPoint?.(entries[idx]?.point ?? null);
          if (dragAnchorIdx !== null) {
            setDragCurrentIdx((prev) => (prev === idx ? prev : idx));
          }
        });
      };

      const handleMouseLeave = () => {
        if (rafIdRef.current !== null) {
          window.cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
        pendingClientXRef.current = null;
        setHoverIdx(null);
        onHoverPoint?.(null);
      };

      // Compute visible selection band coordinates (either active drag or pinned selectedRange)
      const selectionBand = useMemo(() => {
        if (entries.length === 0) return null;

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
          for (let i = 0; i < entries.length; i++) {
            const ts = entries[i].point.timestampMs;
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
      }, [entries, coords, dragAnchorIdx, dragCurrentIdx, selectedRange]);

      const hoverCoord = hoverIdx != null ? coords[hoverIdx] : null;
      const hoverPoint = hoverIdx != null ? entries[hoverIdx]?.point ?? null : null;

      const yTicks = [0, 0.25, 0.5, 0.75, 1];
      const xLabelIndices = useMemo(() => {
        if (entries.length < 2) return [0];
        const count = Math.min(5, entries.length);
        const arr: number[] = [];
        for (let i = 0; i < count; i++) {
          arr.push(Math.round((i / (count - 1)) * (entries.length - 1)));
        }
        return arr;
      }, [entries.length]);

      const pillInfo = useMemo(() => {
        if (selectionBand && selectionBand.isDragging) {
          const p1 = entries[selectionBand.startIdx]?.point;
          const p2 = entries[selectionBand.endIdx]?.point;
          if (p1 && p2) {
            const spanSec = Math.max(
              1,
              Math.round((p2.timestampMs - p1.timestampMs) / 1000) + 1
            );
            return {
              text: `${formatTimeShort(p1.timestampMs)} – ${formatTimeShort(p2.timestampMs)}`,
              sub: `${spanSec}s Bereich`,
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
          const p1 = entries[selectionBand.startIdx]?.point;
          const p2 = entries[selectionBand.endIdx]?.point;
          if (p1 && p2) {
            const spanSec = Math.max(
              1,
              Math.round((p2.timestampMs - p1.timestampMs) / 1000) + 1
            );
            if (selectionBand.startIdx === selectionBand.endIdx) {
              const val = coords[selectionBand.startIdx]?.val ?? 0;
              return {
                text: `${val.toFixed(1)} ${unit}`,
                sub: `um ${formatTimeShort(p1.timestampMs)}`,
                badge: "Fixiert",
              };
            }
            return {
              text: `${formatTimeShort(p1.timestampMs)} – ${formatTimeShort(p2.timestampMs)}`,
              sub: `${spanSec}s`,
              badge: "Bereich",
            };
          }
        }
        return null;
      }, [selectionBand, hoverPoint, hoverCoord, entries, coords, unit]);

      return (
        <div
          className="relative w-full select-none shrink-0"
          style={{ height: `${height}px` }}
        >
          <svg
            ref={svgRef}
            viewBox={`0 0 ${width} ${height}`}
            className="w-full cursor-crosshair block"
            style={{ height: `${height}px` }}
            onMouseEnter={handleMouseEnter}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          >
            <defs>
              <linearGradient id={`area-${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.28" />
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
            {polylinePoints && (
              <polyline
                points={polylinePoints}
                fill="none"
                stroke={color}
                strokeWidth="2.1"
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
            {entries.length > 0 &&
              xLabelIndices.map((idx) => {
                const c = coords[idx];
                const pt = entries[idx]?.point;
                if (!c || !pt) return null;
                return (
                  <text
                    key={idx}
                    x={c.x}
                    y={height - 6}
                    textAnchor={
                      idx === 0
                        ? "start"
                        : idx === entries.length - 1
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
              className="pointer-events-none absolute top-2 right-3 px-2.5 py-1 rounded-lg text-xs font-medium tabular-nums flex items-center gap-2 border whitespace-nowrap"
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
    }
  );

InteractiveAreaChart.displayName = "InteractiveAreaChart";
