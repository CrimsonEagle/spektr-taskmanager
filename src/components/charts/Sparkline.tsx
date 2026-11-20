import React, { useMemo } from "react";

interface SparklineProps {
  data: number[];
  color: string;
  height?: number;
  width?: number;
  maxValue?: number;
  className?: string;
  showEndDot?: boolean;
}

export const Sparkline: React.FC<SparklineProps> = React.memo(
  ({
    data,
    color,
    height = 28,
    width = 88,
    maxValue,
    className = "",
    showEndDot = false,
  }) => {
    const { polylinePoints, polygonPoints, lastX, lastY } = useMemo(() => {
      const points = data.length > 0 ? data : [0, 0];
      let observedMax = 10;
      if (maxValue == null) {
        for (let i = 0; i < points.length; i++) {
          if (points[i] > observedMax) observedMax = points[i];
        }
      }
      const computedMax = maxValue != null ? maxValue : observedMax * 1.15;
      const denom = computedMax || 1;

      const padY = 2.5;
      const usableH = height - padY * 2;
      const stepX = points.length > 1 ? width / (points.length - 1) : width;

      const polyParts: string[] = new Array(points.length);
      let firstX = 0;
      let endX = width;
      let endY = height - padY;

      for (let i = 0; i < points.length; i++) {
        const x = points.length > 1 ? i * stepX : width;
        const v = points[i];
        const norm = v <= 0 ? 0 : v >= denom ? 1 : v / denom;
        const y = height - padY - norm * usableH;
        const sx = x.toFixed(1);
        const sy = y.toFixed(1);
        polyParts[i] = `${sx},${sy}`;
        if (i === 0) firstX = x;
        if (i === points.length - 1) {
          endX = x;
          endY = y;
        }
      }

      const lineStr = polyParts.join(" ");
      const polyStr = `${lineStr} ${endX.toFixed(1)},${height} ${firstX.toFixed(1)},${height}`;

      return {
        polylinePoints: lineStr,
        polygonPoints: polyStr,
        lastX: endX,
        lastY: endY,
      };
    }, [data, width, height, maxValue]);

    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className={`overflow-visible ${className}`}
        preserveAspectRatio="none"
      >
        <polygon points={polygonPoints} fill={color} fillOpacity="0.16" />
        <polyline
          points={polylinePoints}
          fill="none"
          stroke={color}
          strokeWidth="1.65"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {showEndDot && <circle cx={lastX} cy={lastY} r="2.6" fill={color} />}
      </svg>
    );
  }
);

Sparkline.displayName = "Sparkline";
