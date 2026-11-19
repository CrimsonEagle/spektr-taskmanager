import { ProcessCategory } from "../types/telemetry";

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, idx);
  return `${val.toFixed(idx === 0 ? 0 : decimals)} ${units[idx]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 10) return "0 KB/s";
  if (bytesPerSec < 1024 * 1024) {
    return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  }
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function formatPercent(val: number | null | undefined, digits = 0): string {
  if (val == null || !Number.isFinite(val)) return "–";
  return `${val.toFixed(digits)}%`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "< 1m";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}T ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatTimeShort(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function getLoadColor(percent: number): string {
  if (percent >= 85) return "#ef4444";
  if (percent >= 65) return "#f97316";
  if (percent >= 40) return "#eab308";
  return "var(--accent-cpu)";
}

export interface CategoryMeta {
  label: string;
  color: string;
  softBg: string;
}

export const CATEGORY_META: Record<ProcessCategory, CategoryMeta> = {
  browser: {
    label: "Browser",
    color: "#0ea5e9",
    softBg: "rgba(14, 165, 233, 0.14)",
  },
  dev: {
    label: "Dev",
    color: "#8b5cf6",
    softBg: "rgba(139, 92, 246, 0.15)",
  },
  game: {
    label: "Game/3D",
    color: "#10b981",
    softBg: "rgba(16, 185, 129, 0.15)",
  },
  app: {
    label: "App",
    color: "#ec4899",
    softBg: "rgba(236, 72, 153, 0.14)",
  },
  system: {
    label: "System",
    color: "#64748b",
    softBg: "rgba(100, 116, 139, 0.15)",
  },
  background: {
    label: "Hintergrund",
    color: "#f59e0b",
    softBg: "rgba(245, 158, 11, 0.14)",
  },
};

export function getCategoryMeta(cat: string): CategoryMeta {
  return CATEGORY_META[cat as ProcessCategory] ?? CATEGORY_META.background;
}

export function getProcessMonogram(name: string): string {
  const clean = name.replace(/\.exe$/i, "").trim();
  if (!clean) return "P";
  const parts = clean.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}
