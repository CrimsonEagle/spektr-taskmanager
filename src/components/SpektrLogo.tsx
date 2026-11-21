import React, { useId } from "react";

interface SpektrLogoProps {
  size?: number;
  className?: string;
}

/**
 * Custom vector Spektr Prism emblem matching the app's optical glass prism identity:
 * a deep obsidian squircle with a luminous incoming white beam refracted through
 * a faceted crystal prism into the 5 semantic system colors (CPU, RAM, GPU, Disk, Network).
 */
export const SpektrLogo: React.FC<SpektrLogoProps> = React.memo(
  ({ size = 24, className = "" }) => {
    const uid = useId().replace(/:/g, "");
    const bgId = `spektr-bg-${uid}`;
    const rimId = `spektr-rim-${uid}`;
    const prismLId = `spektr-pl-${uid}`;
    const prismRId = `spektr-pr-${uid}`;
    const prismBId = `spektr-pb-${uid}`;

    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={`shrink-0 ${className}`}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={bgId} x1="8" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#171e2f" />
            <stop offset="55%" stopColor="#0f1420" />
            <stop offset="100%" stopColor="#090d16" />
          </linearGradient>
          <linearGradient id={rimId} x1="8" y1="6" x2="56" y2="58" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#94a3b8" stopOpacity="0.45" />
            <stop offset="50%" stopColor="#38bdf8" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#a78bfa" stopOpacity="0.32" />
          </linearGradient>
          <linearGradient id={prismLId} x1="17" y1="16" x2="32" y2="48" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#f8fafc" stopOpacity="0.72" />
            <stop offset="100%" stopColor="#94a3b8" stopOpacity="0.28" />
          </linearGradient>
          <linearGradient id={prismRId} x1="32" y1="16" x2="48" y2="46" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#e2e8f0" stopOpacity="0.44" />
            <stop offset="100%" stopColor="#cbd5e1" stopOpacity="0.16" />
          </linearGradient>
          <linearGradient id={prismBId} x1="17" y1="44" x2="47" y2="50" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#cbd5e1" stopOpacity="0.34" />
            <stop offset="100%" stopColor="#64748b" stopOpacity="0.18" />
          </linearGradient>
          <clipPath id={`spektr-clip-${uid}`}>
            <rect x="2" y="2" width="60" height="60" rx="14" />
          </clipPath>
        </defs>

        <g clipPath={`url(#spektr-clip-${uid})`}>
          {/* Deep obsidian squircle base */}
          <rect x="2" y="2" width="60" height="60" rx="14" fill={`url(#${bgId})`} />

          {/* Incoming clean white telemetry beam */}
          <line
            x1="0"
            y1="39.5"
            x2="24.5"
            y2="30.5"
            stroke="#ffffff"
            strokeWidth="2.6"
            strokeLinecap="round"
          />

          {/* 5 refracted spectral light ribbons (CPU, RAM, GPU, Disk, Network) */}
          <g strokeWidth="2.2" strokeLinecap="round">
            <line x1="37" y1="27.2" x2="64" y2="29.5" stroke="#38bdf8" />
            <line x1="38.2" y1="29.4" x2="64" y2="33.3" stroke="#a78bfa" />
            <line x1="39.4" y1="31.6" x2="64" y2="37.2" stroke="#34d399" />
            <line x1="40.6" y1="33.8" x2="64" y2="41.1" stroke="#fbbf24" />
            <line x1="41.8" y1="36.0" x2="64" y2="45.0" stroke="#fb7185" />
          </g>

          {/* Subtle internal refraction dispersion glow inside prism */}
          <polygon
            points="23.5,30.8 39.5,27.5 42.5,36.2"
            fill="#ffffff"
            fillOpacity="0.24"
          />

          {/* 3D Faceted Optical Glass Prism */}
          <polygon points="32,14 15.5,44.5 32,49.5" fill={`url(#${prismLId})`} />
          <polygon points="32,14 48.5,44.5 32,49.5" fill={`url(#${prismRId})`} />
          <polygon points="15.5,44.5 32,49.5 48.5,44.5 32,40.5" fill={`url(#${prismBId})`} />

          {/* Crisp crystal specular edges */}
          <path
            d="M32 14 L15.5 44.5 L32 49.5 L48.5 44.5 Z"
            stroke="#f8fafc"
            strokeOpacity="0.72"
            strokeWidth="1.25"
            strokeLinejoin="round"
          />
          <line
            x1="32"
            y1="14"
            x2="32"
            y2="49.5"
            stroke="#ffffff"
            strokeOpacity="0.6"
            strokeWidth="1.15"
          />
        </g>

        {/* Outer glass squircle rim */}
        <rect
          x="2.6"
          y="2.6"
          width="58.8"
          height="58.8"
          rx="13.4"
          stroke={`url(#${rimId})`}
          strokeWidth="1.2"
        />
      </svg>
    );
  }
);

SpektrLogo.displayName = "SpektrLogo";
