import { useCallback, useEffect, useState } from "react";

export type RefreshRateMs = 500 | 1000 | 2000 | 5000;

export interface TitleBarMetricsConfig {
  cpu: boolean;
  ram: boolean;
  gpu: boolean;
  disk: boolean;
  network: boolean;
}

export interface HudMetricsConfig {
  cpu: boolean;
  ram: boolean;
  gpu: boolean;
  disk: boolean;
  network: boolean;
  topProcess: boolean;
  battery: boolean;
}

export interface AppSettings {
  refreshMs: RefreshRateMs;
  minimizeToTray: boolean;
  trayCpuIcon: boolean;
  titleBarMetrics: TitleBarMetricsConfig;
  hudMetrics: HudMetricsConfig;
}

const STORAGE_KEY = "pulse_app_settings_v2";
const LEGACY_REFRESH_KEY = "pulse_refresh_ms";
const LEGACY_TRAY_KEY = "pulse_minimize_to_tray";

const VALID_REFRESH_MS = new Set<number>([500, 1000, 2000, 5000]);

export const DEFAULT_SETTINGS: AppSettings = {
  refreshMs: 1000,
  minimizeToTray: false,
  trayCpuIcon: true,
  titleBarMetrics: {
    cpu: true,
    ram: true,
    gpu: true,
    disk: false,
    network: false,
  },
  hudMetrics: {
    cpu: true,
    ram: true,
    gpu: true,
    disk: true,
    network: true,
    topProcess: true,
    battery: true,
  },
};

function loadInitialSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      const refreshMs = VALID_REFRESH_MS.has(Number(parsed.refreshMs))
        ? (Number(parsed.refreshMs) as RefreshRateMs)
        : DEFAULT_SETTINGS.refreshMs;
      return {
        refreshMs,
        minimizeToTray:
          typeof parsed.minimizeToTray === "boolean"
            ? parsed.minimizeToTray
            : DEFAULT_SETTINGS.minimizeToTray,
        trayCpuIcon:
          typeof parsed.trayCpuIcon === "boolean"
            ? parsed.trayCpuIcon
            : DEFAULT_SETTINGS.trayCpuIcon,
        titleBarMetrics: {
          ...DEFAULT_SETTINGS.titleBarMetrics,
          ...(parsed.titleBarMetrics ?? {}),
        },
        hudMetrics: {
          ...DEFAULT_SETTINGS.hudMetrics,
          ...(parsed.hudMetrics ?? {}),
        },
      };
    }

    // Migrate legacy keys if present
    const legacyRefresh = Number(localStorage.getItem(LEGACY_REFRESH_KEY));
    const legacyTray = localStorage.getItem(LEGACY_TRAY_KEY) === "1";
    return {
      ...DEFAULT_SETTINGS,
      refreshMs: VALID_REFRESH_MS.has(legacyRefresh)
        ? (legacyRefresh as RefreshRateMs)
        : DEFAULT_SETTINGS.refreshMs,
      minimizeToTray: legacyTray,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(loadInitialSettings);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // ignore storage quota errors
    }
  }, [settings]);

  const setRefreshMs = useCallback((refreshMs: RefreshRateMs) => {
    setSettings((prev) => ({ ...prev, refreshMs }));
  }, []);

  const setMinimizeToTray = useCallback((minimizeToTray: boolean) => {
    setSettings((prev) => ({ ...prev, minimizeToTray }));
  }, []);

  const setTrayCpuIcon = useCallback((trayCpuIcon: boolean) => {
    setSettings((prev) => ({ ...prev, trayCpuIcon }));
  }, []);

  const toggleTitleBarMetric = useCallback(
    (key: keyof TitleBarMetricsConfig) => {
      setSettings((prev) => ({
        ...prev,
        titleBarMetrics: {
          ...prev.titleBarMetrics,
          [key]: !prev.titleBarMetrics[key],
        },
      }));
    },
    []
  );

  const toggleHudMetric = useCallback((key: keyof HudMetricsConfig) => {
    setSettings((prev) => ({
      ...prev,
      hudMetrics: {
        ...prev.hudMetrics,
        [key]: !prev.hudMetrics[key],
      },
    }));
  }, []);

  return {
    settings,
    setRefreshMs,
    setMinimizeToTray,
    setTrayCpuIcon,
    toggleTitleBarMetric,
    toggleHudMetric,
  };
}
