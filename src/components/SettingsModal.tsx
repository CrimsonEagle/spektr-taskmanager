import React, { useEffect } from "react";
import { motion } from "framer-motion";
import { Monitor, Moon, Settings, Sun, X } from "lucide-react";
import {
  AppSettings,
  HudMetricsConfig,
  RefreshRateMs,
  TitleBarMetricsConfig,
} from "../hooks/useSettings";
import { ThemePreference } from "../types/telemetry";

interface SettingsModalProps {
  settings: AppSettings;
  themePreference: ThemePreference;
  onSetTheme: (pref: ThemePreference) => void;
  onSetRefreshMs: (ms: RefreshRateMs) => void;
  onSetMinimizeToTray: (enabled: boolean) => void;
  onSetTrayCpuIcon: (enabled: boolean) => void;
  onToggleTitleBarMetric: (key: keyof TitleBarMetricsConfig) => void;
  onToggleHudMetric: (key: keyof HudMetricsConfig) => void;
  onClose: () => void;
}

const REFRESH_OPTIONS: { ms: RefreshRateMs; label: string }[] = [
  { ms: 500, label: "0.5s" },
  { ms: 1000, label: "1s" },
  { ms: 2000, label: "2s" },
  { ms: 5000, label: "5s" },
];

const TITLEBAR_ITEMS: { key: keyof TitleBarMetricsConfig; label: string }[] = [
  { key: "cpu", label: "CPU" },
  { key: "ram", label: "RAM" },
  { key: "gpu", label: "GPU" },
  { key: "disk", label: "Datenträger" },
  { key: "network", label: "Netzwerk" },
];

const HUD_ITEMS: { key: keyof HudMetricsConfig; label: string }[] = [
  { key: "cpu", label: "CPU (% + GHz)" },
  { key: "ram", label: "RAM (% + GB)" },
  { key: "gpu", label: "GPU (% + Temp/VRAM)" },
  { key: "disk", label: "Datenträger (R/W)" },
  { key: "network", label: "Netzwerk (↓/↑)" },
  { key: "topProcess", label: "Top-Prozess" },
  { key: "battery", label: "Akku (falls vorhanden)" },
];

const ToggleSwitch: React.FC<{
  checked: boolean;
  onChange: () => void;
  label: string;
}> = ({ checked, onChange, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    onClick={onChange}
    className="w-9 h-5 rounded-full p-0.5 transition-colors cursor-pointer flex items-center shrink-0"
    style={{
      backgroundColor: checked ? "var(--accent-cpu)" : "var(--border-strong)",
      justifyContent: checked ? "flex-end" : "flex-start",
    }}
  >
    <span className="w-4 h-4 rounded-full bg-white shadow-sm block" />
  </button>
);

export const SettingsModal: React.FC<SettingsModalProps> = React.memo(
  ({
    settings,
    themePreference,
    onSetTheme,
    onSetRefreshMs,
    onSetMinimizeToTray,
    onSetTrayCpuIcon,
    onToggleTitleBarMetric,
    onToggleHudMetric,
    onClose,
  }) => {
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") onClose();
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.14 }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        style={{
          backgroundColor: "rgba(0, 0, 0, 0.42)",
          backdropFilter: "blur(6px)",
        }}
      >
        <motion.div
          initial={{ opacity: 0, y: -12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.97 }}
          transition={{ type: "spring", stiffness: 460, damping: 34 }}
          className="w-full max-w-lg max-h-[85vh] rounded-2xl border overflow-hidden flex flex-col"
          style={{
            backgroundColor: "var(--bg-drawer)",
            borderColor: "var(--border-strong)",
            boxShadow: "var(--shadow-float)",
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-4 py-3.5 border-b shrink-0"
            style={{ borderColor: "var(--border-subtle)" }}
          >
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Settings
                className="w-4 h-4"
                style={{ color: "var(--accent-cpu)" }}
              />
              <span>Einstellungen</span>
            </div>
            <button
              onClick={onClose}
              className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer hover:bg-[var(--bg-surface-hover)]"
              style={{ color: "var(--text-secondary)" }}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Scrollable Body */}
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5 text-xs">
            {/* Section 1: Allgemein */}
            <section className="flex flex-col gap-2.5">
              <h4
                className="text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: "var(--text-muted)" }}
              >
                Allgemein
              </h4>

              {/* Refresh Rate */}
              <div
                className="p-3 rounded-xl border flex items-center justify-between gap-3"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <div>
                  <div className="font-semibold">Aktualisierungsrate</div>
                  <div
                    className="text-[11px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Intervall für Live-Systemdaten (Leertaste pausiert)
                  </div>
                </div>
                <div
                  className="flex items-center p-0.5 rounded-lg border gap-0.5 shrink-0"
                  style={{
                    backgroundColor: "var(--bg-surface-solid)",
                    borderColor: "var(--border-subtle)",
                  }}
                >
                  {REFRESH_OPTIONS.map((opt) => {
                    const active = settings.refreshMs === opt.ms;
                    return (
                      <button
                        key={opt.ms}
                        onClick={() => onSetRefreshMs(opt.ms)}
                        className="px-2 py-1 rounded-md text-[11px] font-semibold tabular-nums cursor-pointer transition-colors"
                        style={{
                          backgroundColor: active
                            ? "var(--accent-cpu-soft)"
                            : "transparent",
                          color: active
                            ? "var(--accent-cpu)"
                            : "var(--text-secondary)",
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Minimize to Tray */}
              <div
                className="p-3 rounded-xl border flex items-center justify-between gap-3"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <div>
                  <div className="font-semibold">In System-Tray minimieren</div>
                  <div
                    className="text-[11px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Beim Schließen im Hintergrund im Infobereich weiterlaufen
                  </div>
                </div>
                <ToggleSwitch
                  checked={settings.minimizeToTray}
                  onChange={() => onSetMinimizeToTray(!settings.minimizeToTray)}
                  label="In System-Tray minimieren"
                />
              </div>

              {/* Live CPU Tray Icon */}
              <div
                className="p-3 rounded-xl border flex items-center justify-between gap-3"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <div>
                  <div className="font-semibold">
                    Live-CPU-Chart im Tray-Icon
                  </div>
                  <div
                    className="text-[11px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Zeigt die aktuelle CPU-Auslastung dynamisch im Taskleisten-Symbol
                  </div>
                </div>
                <ToggleSwitch
                  checked={settings.trayCpuIcon}
                  onChange={() => onSetTrayCpuIcon(!settings.trayCpuIcon)}
                  label="Live-CPU-Chart im Tray-Icon"
                />
              </div>

              {/* Theme */}
              <div
                className="p-3 rounded-xl border flex items-center justify-between gap-3"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <div>
                  <div className="font-semibold">Design</div>
                  <div
                    className="text-[11px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Farbschema der Benutzeroberfläche
                  </div>
                </div>
                <div
                  className="flex items-center p-0.5 rounded-lg border gap-0.5 shrink-0"
                  style={{
                    backgroundColor: "var(--bg-surface-solid)",
                    borderColor: "var(--border-subtle)",
                  }}
                >
                  {(
                    [
                      {
                        id: "system",
                        label: "System",
                        icon: <Monitor className="w-3 h-3" />,
                      },
                      {
                        id: "light",
                        label: "Hell",
                        icon: <Sun className="w-3 h-3" />,
                      },
                      {
                        id: "dark",
                        label: "Dunkel",
                        icon: <Moon className="w-3 h-3" />,
                      },
                    ] as const
                  ).map((t) => {
                    const active = themePreference === t.id;
                    return (
                      <button
                        key={t.id}
                        onClick={() => onSetTheme(t.id)}
                        className="px-2 py-1 rounded-md text-[11px] font-semibold flex items-center gap-1 cursor-pointer transition-colors"
                        style={{
                          backgroundColor: active
                            ? "var(--accent-cpu-soft)"
                            : "transparent",
                          color: active
                            ? "var(--accent-cpu)"
                            : "var(--text-secondary)",
                        }}
                      >
                        {t.icon}
                        <span>{t.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>

            {/* Section 2: Titelleiste */}
            <section className="flex flex-col gap-2">
              <h4
                className="text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: "var(--text-muted)" }}
              >
                Titelleiste — Live-Metrik-Pills
              </h4>
              <div
                className="p-3 rounded-xl border grid grid-cols-2 gap-2.5"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                {TITLEBAR_ITEMS.map((item) => (
                  <div
                    key={item.key}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="font-medium">{item.label}</span>
                    <ToggleSwitch
                      checked={settings.titleBarMetrics[item.key]}
                      onChange={() => onToggleTitleBarMetric(item.key)}
                      label={`Titelleiste ${item.label}`}
                    />
                  </div>
                ))}
              </div>
            </section>

            {/* Section 3: Mini-HUD */}
            <section className="flex flex-col gap-2">
              <h4
                className="text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: "var(--text-muted)" }}
              >
                Mini-HUD — Angezeigte Kacheln
              </h4>
              <div
                className="p-3 rounded-xl border grid grid-cols-2 gap-2.5"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                {HUD_ITEMS.map((item) => (
                  <div
                    key={item.key}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="font-medium truncate">{item.label}</span>
                    <ToggleSwitch
                      checked={settings.hudMetrics[item.key]}
                      onChange={() => onToggleHudMetric(item.key)}
                      label={`Mini-HUD ${item.label}`}
                    />
                  </div>
                ))}
              </div>
            </section>
          </div>
        </motion.div>
      </motion.div>
    );
  }
);

SettingsModal.displayName = "SettingsModal";
