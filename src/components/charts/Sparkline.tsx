import React, { useId } from "react";

interface SparklineProps {
  data: number[];
  color: string;
  height?: number;
  width?: number;
  maxValue?: number;
  className?: string;
  showEndDot?: boolean;
}

export const Sparkline: React.FC<SparklineProps> = ({
  data,
  color,
  height = 28,
  width = 88,
  maxValue,
  className = "",
  showEndDot = false,
}) => {
  const uid = useId().replace(/:/g, "");
  const points = data.length > 0 ? data : [0, 0];
  const computedMax =
    maxValue != null ? maxValue : Math.max(10, ...points) * 1.15;

  const padY = 2.5;
  const usableH = height - padY * 2;
  const stepX = points.length > 1 ? width / (points.length - 1) : width;

  const coords = points.map((v, i) => {
    const x = points.length > 1 ? i * stepX : width;
    const norm = Math.max(0, Math.min(1, v / (computedMax || 1)));
    const y = height - padY - norm * usableH;
    return [x, y] as const;
  });

  // Smooth cubic bezier path
  let linePath = `M ${coords[0][0].toFixed(1)} ${coords[0][1].toFixed(1)}`;
  for (let i = 1; i < coords.length; i++) {
    const [x0, y0] = coords[i - 1];
    const [x1, y1] = coords[i];
    const cx = (x0 + x1) / 2;
    linePath += ` C ${cx.toFixed(1)} ${y0.toFixed(1)}, ${cx.toFixed(1)} ${y1.toFixed(1)}, ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }

  const last = coords[coords.length - 1];
  const first = coords[0];
  const areaPath = `${linePath} L ${last[0].toFixed(1)} ${height} L ${first[0].toFixed(1)} ${height} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`overflow-visible ${className}`}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={`sp-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.34" />
          <stop offset="100%" stopColor={color} stopOpacity="0.0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#sp-${uid})`} />
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {showEndDot && (
        <circle cx={last[0]} cy={last[1]} r="2.6" fill={color} />
      )}
    </svg>
  );
};
