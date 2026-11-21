import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  GearSix as Settings,
  Globe,
  Monitor,
  Moon,
  Sun,
  X,
} from "@phosphor-icons/react";
import {
  AppSettings,
  HudMetricsConfig,
  RefreshRateMs,
  TitleBarMetricsConfig,
} from "../hooks/useSettings";
import { useI18n } from "../i18n";
import { api } from "../lib/tauri";
import {
  ActionResult,
  AutostartMode,
  LanguagePreference,
  ThemePreference,
} from "../types/telemetry";

interface SettingsModalProps {
  settings: AppSettings;
  themePreference: ThemePreference;
  languagePreference: LanguagePreference;
  onSetTheme: (pref: ThemePreference) => void;
  onSetLanguage: (pref: LanguagePreference) => void;
  onSetRefreshMs: (ms: RefreshRateMs) => void;
  onSetCloseToTray: (enabled: boolean) => void;
  onSetMinimizeToTrayOnMinimize: (enabled: boolean) => void;
  onSetTrayCpuIcon: (enabled: boolean) => void;
  onToggleTitleBarMetric: (key: keyof TitleBarMetricsConfig) => void;
  onToggleHudMetric: (key: keyof HudMetricsConfig) => void;
  onActionFeedback?: (res: ActionResult) => void;
  onClose: () => void;
}

const REFRESH_OPTIONS: { ms: RefreshRateMs; label: string }[] = [
  { ms: 500, label: "0.5s" },
  { ms: 1000, label: "1s" },
  { ms: 2000, label: "2s" },
  { ms: 5000, label: "5s" },
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
    languagePreference,
    onSetTheme,
    onSetLanguage,
    onSetRefreshMs,
    onSetCloseToTray,
    onSetMinimizeToTrayOnMinimize,
    onSetTrayCpuIcon,
    onToggleTitleBarMetric,
    onToggleHudMetric,
    onActionFeedback,
    onClose,
  }) => {
    const { t } = useI18n();
    const [autostartEnabled, setAutostartEnabled] = useState(false);
    const [autostartMode, setAutostartMode] =
      useState<AutostartMode>("minimized");
    const [autostartBusy, setAutostartBusy] = useState(false);

    const autostartModes: { id: AutostartMode; label: string }[] = [
      { id: "normal", label: t("settings.autostart.mode.normal") },
      { id: "maximized", label: t("settings.autostart.mode.maximized") },
      { id: "minimized", label: t("settings.autostart.mode.minimized") },
    ];

    const titleBarItems: { key: keyof TitleBarMetricsConfig; label: string }[] =
      [
        { key: "cpu", label: "CPU" },
        { key: "ram", label: "RAM" },
        { key: "gpu", label: "GPU" },
        { key: "disk", label: t("settings.metric.disk") },
        { key: "network", label: t("settings.metric.network") },
      ];

    const hudItems: { key: keyof HudMetricsConfig; label: string }[] = [
      { key: "cpu", label: t("settings.hud.cpu") },
      { key: "ram", label: t("settings.hud.ram") },
      { key: "gpu", label: t("settings.hud.gpu") },
      { key: "disk", label: t("settings.hud.disk") },
      { key: "network", label: t("settings.hud.network") },
      { key: "topProcess", label: t("settings.hud.topProcess") },
      { key: "battery", label: t("settings.hud.battery") },
    ];

    useEffect(() => {
      let active = true;
      api
        .getAutostartConfig()
        .then((cfg) => {
          if (!active) return;
          setAutostartEnabled(cfg.enabled);
          if (
            cfg.mode === "normal" ||
            cfg.mode === "maximized" ||
            cfg.mode === "minimized"
          ) {
            setAutostartMode(cfg.mode);
          }
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }, []);

    const updateAutostart = async (
      nextEnabled: boolean,
      nextMode: AutostartMode
    ) => {
      if (autostartBusy) return;
      setAutostartBusy(true);
      try {
        const saved = await api.setAutostartConfig(nextEnabled, nextMode);
        setAutostartEnabled(saved.enabled);
        setAutostartMode(saved.mode);
        const modeLabel =
          saved.mode === "maximized"
            ? t("settings.autostart.mode.maximized")
            : saved.mode === "minimized"
              ? t("settings.autostart.mode.minimizedMsg")
              : t("settings.autostart.mode.normal");
        onActionFeedback?.({
          ok: true,
          message: saved.enabled
            ? t("settings.autostart.enabledToast", { mode: modeLabel })
            : t("settings.autostart.disabledToast"),
        });
      } catch (err) {
        onActionFeedback?.({
          ok: false,
          message: t("settings.autostart.errorToast", { err: String(err) }),
        });
      } finally {
        setAutostartBusy(false);
      }
    };

    const handleSelectAutostartMode = (mode: AutostartMode) => {
      setAutostartMode(mode);
      if (autostartEnabled) {
        updateAutostart(true, mode);
      }
    };

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
              <span>{t("settings.title")}</span>
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
                {t("settings.section.general")}
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
                  <div className="font-semibold">{t("settings.refresh.title")}</div>
                  <div
                    className="text-[11px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {t("settings.refresh.desc")}
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

              {/* Windows Autostart & Start Mode */}
              <div
                className="p-3 rounded-xl border flex flex-col gap-2.5"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-semibold">
                      {t("settings.autostart.title")}
                    </div>
                    <div
                      className="text-[11px]"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {t("settings.autostart.desc")}
                    </div>
                  </div>
                  <ToggleSwitch
                    checked={autostartEnabled}
                    onChange={() =>
                      updateAutostart(!autostartEnabled, autostartMode)
                    }
                    label={t("settings.autostart.title")}
                  />
                </div>

                <div
                  className={`flex items-center justify-between gap-3 pt-2 border-t transition-opacity ${
                    autostartEnabled ? "opacity-100" : "opacity-55"
                  }`}
                  style={{ borderColor: "var(--border-subtle)" }}
                >
                  <span
                    className="text-[11px] font-medium"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {t("settings.autostart.modeLabel")}
                  </span>
                  <div
                    className="flex items-center p-0.5 rounded-lg border gap-0.5 shrink-0"
                    style={{
                      backgroundColor: "var(--bg-surface-solid)",
                      borderColor: "var(--border-subtle)",
                    }}
                  >
                    {autostartModes.map((m) => {
                      const active = autostartMode === m.id;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          disabled={autostartBusy}
                          onClick={() => handleSelectAutostartMode(m.id)}
                          className="px-2 py-1 rounded-md text-[11px] font-semibold cursor-pointer transition-colors disabled:opacity-50"
                          style={{
                            backgroundColor: active
                              ? "var(--accent-cpu-soft)"
                              : "transparent",
                            color: active
                              ? "var(--accent-cpu)"
                              : "var(--text-secondary)",
                          }}
                        >
                          {m.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Minimize to Tray (Zero-WebView RAM saving) */}
              <div
                className="p-3 rounded-xl border flex flex-col gap-2.5"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <div>
                  <div className="font-semibold">{t("settings.tray.title")}</div>
                  <div
                    className="text-[11px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {t("settings.tray.desc")}
                  </div>
                </div>

                <div
                  className="flex items-center justify-between gap-3 pt-2 border-t"
                  style={{ borderColor: "var(--border-subtle)" }}
                >
                  <div>
                    <div className="font-medium">{t("settings.tray.onClose")}</div>
                    <div
                      className="text-[11px]"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {t("settings.tray.onCloseDesc")}
                    </div>
                  </div>
                  <ToggleSwitch
                    checked={settings.closeToTray}
                    onChange={() => onSetCloseToTray(!settings.closeToTray)}
                    label={t("settings.tray.onCloseAria")}
                  />
                </div>

                <div
                  className="flex items-center justify-between gap-3 pt-2 border-t"
                  style={{ borderColor: "var(--border-subtle)" }}
                >
                  <div>
                    <div className="font-medium">
                      {t("settings.tray.onMinimize")}
                    </div>
                    <div
                      className="text-[11px]"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {t("settings.tray.onMinimizeDesc")}
                    </div>
                  </div>
                  <ToggleSwitch
                    checked={settings.minimizeToTrayOnMinimize}
                    onChange={() =>
                      onSetMinimizeToTrayOnMinimize(
                        !settings.minimizeToTrayOnMinimize
                      )
                    }
                    label={t("settings.tray.onMinimizeAria")}
                  />
                </div>
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
                    {t("settings.trayChart.title")}
                  </div>
                  <div
                    className="text-[11px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {t("settings.trayChart.desc")}
                  </div>
                </div>
                <ToggleSwitch
                  checked={settings.trayCpuIcon}
                  onChange={() => onSetTrayCpuIcon(!settings.trayCpuIcon)}
                  label={t("settings.trayChart.title")}
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
                  <div className="font-semibold">{t("settings.theme.title")}</div>
                  <div
                    className="text-[11px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {t("settings.theme.desc")}
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
                        label: t("settings.theme.system"),
                        icon: <Monitor className="w-3 h-3" />,
                      },
                      {
                        id: "light",
                        label: t("settings.theme.light"),
                        icon: <Sun className="w-3 h-3" />,
                      },
                      {
                        id: "dark",
                        label: t("settings.theme.dark"),
                        icon: <Moon className="w-3 h-3" />,
                      },
                    ] as const
                  ).map((th) => {
                    const active = themePreference === th.id;
                    return (
                      <button
                        key={th.id}
                        onClick={() => onSetTheme(th.id)}
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
                        {th.icon}
                        <span>{th.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Language */}
              <div
                className="p-3 rounded-xl border flex items-center justify-between gap-3"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <div>
                  <div className="font-semibold flex items-center gap-1.5">
                    <Globe
                      className="w-3.5 h-3.5"
                      style={{ color: "var(--accent-cpu)" }}
                    />
                    <span>{t("settings.language.title")}</span>
                  </div>
                  <div
                    className="text-[11px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {t("settings.language.desc")}
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
                      { id: "system", label: t("settings.language.system") },
                      { id: "de", label: t("settings.language.de") },
                      { id: "en", label: t("settings.language.en") },
                    ] as const
                  ).map((l) => {
                    const active = languagePreference === l.id;
                    return (
                      <button
                        key={l.id}
                        onClick={() => onSetLanguage(l.id)}
                        className="px-2 py-1 rounded-md text-[11px] font-semibold cursor-pointer transition-colors"
                        style={{
                          backgroundColor: active
                            ? "var(--accent-cpu-soft)"
                            : "transparent",
                          color: active
                            ? "var(--accent-cpu)"
                            : "var(--text-secondary)",
                        }}
                      >
                        {l.label}
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
                {t("settings.section.titlebar")}
              </h4>
              <div
                className="p-3 rounded-xl border grid grid-cols-2 gap-2.5"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                {titleBarItems.map((item) => (
                  <div
                    key={item.key}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="font-medium">{item.label}</span>
                    <ToggleSwitch
                      checked={settings.titleBarMetrics[item.key]}
                      onChange={() => onToggleTitleBarMetric(item.key)}
                      label={`${t("settings.section.titlebar")} ${item.label}`}
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
                {t("settings.section.hud")}
              </h4>
              <div
                className="p-3 rounded-xl border grid grid-cols-2 gap-2.5"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                {hudItems.map((item) => (
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
