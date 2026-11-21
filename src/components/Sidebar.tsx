import React from "react";
import { motion } from "framer-motion";
import {
  Cpu,
  Flame,
  Gauge,
  Leaf,
  Pulse as Activity,
  ShareNetwork as Network,
  SquaresFour as LayoutDashboard,
  TreeStructure as ListTree,
  Wrench,
} from "@phosphor-icons/react";
import { useI18n } from "../i18n";
import { formatDuration } from "../lib/format";
import { APP_VERSION } from "../lib/version";
import { NavTab, TelemetrySnapshot } from "../types/telemetry";

interface SidebarProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  snapshot: TelemetrySnapshot | null;
  onApplyProfile: (profile: "normal" | "eco" | "gaming") => void;
}

interface NavItemDef {
  id: NavTab;
  label: string;
  icon: React.ReactNode;
  accent: string;
  accentSoft: string;
  badge?: number;
}

export const Sidebar: React.FC<SidebarProps> = React.memo(({
  activeTab,
  onSelectTab,
  snapshot,
  onApplyProfile,
}) => {
  const { t, language } = useI18n();
  const navItems: NavItemDef[] = [
    {
      id: "overview",
      label: t("nav.overview"),
      icon: <LayoutDashboard className="w-4 h-4" />,
      accent: "var(--accent-cpu)",
      accentSoft: "var(--accent-cpu-soft)",
    },
    {
      id: "processes",
      label: t("nav.processes"),
      icon: <ListTree className="w-4 h-4" />,
      accent: "var(--accent-ram)",
      accentSoft: "var(--accent-ram-soft)",
      badge: snapshot?.system.processCount,
    },
    {
      id: "performance",
      label: t("nav.performance"),
      icon: <Activity className="w-4 h-4" />,
      accent: "var(--accent-gpu)",
      accentSoft: "var(--accent-gpu-soft)",
    },
    {
      id: "network",
      label: t("nav.network"),
      icon: <Network className="w-4 h-4" />,
      accent: "var(--accent-net)",
      accentSoft: "var(--accent-net-soft)",
      badge: snapshot?.system.listeningPortsCount,
    },
    {
      id: "tools",
      label: t("nav.tools"),
      icon: <Wrench className="w-4 h-4" />,
      accent: "var(--accent-disk)",
      accentSoft: "var(--accent-disk-soft)",
    },
  ];

  const activeProfile = snapshot?.system.activeProfile ?? "normal";

  return (
    <aside
      className="w-56 shrink-0 flex flex-col justify-between p-3 border-r"
      style={{
        backgroundColor: "var(--bg-sidebar)",
        borderColor: "var(--border-subtle)",
      }}
    >
      {/* Navigation Links */}
      <nav className="flex flex-col gap-1">
        {navItems.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onSelectTab(item.id)}
              className="relative flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-medium transition-colors cursor-pointer text-left"
              style={{
                color: isActive ? item.accent : "var(--text-secondary)",
              }}
            >
              {isActive && (
                <motion.div
                  layoutId="sidebarActivePill"
                  transition={{ type: "spring", stiffness: 420, damping: 32 }}
                  className="absolute inset-0 rounded-xl"
                  style={{
                    backgroundColor: item.accentSoft,
                    border: `1px solid ${item.accent}33`,
                  }}
                />
              )}
              <span className="relative z-10 flex items-center gap-2.5">
                {item.icon}
                <span>{item.label}</span>
              </span>
              {item.badge != null && (
                <span
                  className="relative z-10 text-[11px] px-1.5 py-0.5 rounded-md tabular-nums font-semibold"
                  style={{
                    backgroundColor: isActive
                      ? "var(--bg-surface-solid)"
                      : "var(--bg-subtle)",
                    color: isActive ? item.accent : "var(--text-muted)",
                  }}
                >
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Bottom: Quick Profile Switcher + System Info */}
      <div className="flex flex-col gap-2.5">
        <div
          className="p-2.5 rounded-xl border"
          style={{
            backgroundColor: "var(--bg-surface)",
            borderColor: "var(--border-subtle)",
          }}
        >
          <div className="flex items-center justify-between mb-2 px-0.5">
            <span
              className="text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: "var(--text-muted)" }}
            >
              {t("sidebar.quickProfile")}
            </span>
            {activeProfile !== "normal" && (
              <span
                className="flex items-center gap-1 text-[10px] font-semibold"
                style={{
                  color:
                    activeProfile === "eco"
                      ? "var(--accent-gpu)"
                      : "var(--accent-disk)",
                }}
                title={t("sidebar.autoTooltip")}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-current" />
                {t("sidebar.auto")}
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-1">
            {(
              [
                {
                  id: "normal",
                  label: t("sidebar.profile.normal"),
                  icon: <Gauge className="w-3.5 h-3.5" />,
                  color: "var(--accent-cpu)",
                  tooltip: t("sidebar.profile.normalTooltip"),
                },
                {
                  id: "eco",
                  label: t("sidebar.profile.eco"),
                  icon: <Leaf className="w-3.5 h-3.5" />,
                  color: "var(--accent-gpu)",
                  tooltip: t("sidebar.profile.ecoTooltip"),
                },
                {
                  id: "gaming",
                  label: t("sidebar.profile.boost"),
                  icon: <Flame className="w-3.5 h-3.5" />,
                  color: "var(--accent-disk)",
                  tooltip: t("sidebar.profile.boostTooltip"),
                },
              ] as const
            ).map((p) => {
              const selected = activeProfile === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => onApplyProfile(p.id)}
                  title={p.tooltip}
                  className="flex flex-col items-center gap-1 py-1.5 px-1 rounded-lg text-[11px] font-medium transition-colors cursor-pointer"
                  style={{
                    backgroundColor: selected
                      ? "var(--bg-surface-active)"
                      : "transparent",
                    color: selected ? p.color : "var(--text-secondary)",
                    border: selected
                      ? `1px solid ${p.color}44`
                      : "1px solid transparent",
                  }}
                >
                  {p.icon}
                  <span>{p.label}</span>
                </button>
              );
            })}
          </div>

          {activeProfile !== "normal" && snapshot && (
            <div
              className="mt-2 pt-2 border-t text-[10px] leading-snug tabular-nums flex items-center justify-between"
              style={{
                borderColor: "var(--border-subtle)",
                color: "var(--text-muted)",
              }}
            >
              {activeProfile === "gaming" ? (
                <span>
                  {t("sidebar.profile.boostedSummary", {
                    boosted: snapshot.system.profileBoostedCount,
                    throttled: Math.max(
                      0,
                      snapshot.system.profileManagedCount -
                        snapshot.system.profileBoostedCount
                    ),
                  })}
                </span>
              ) : (
                <span>
                  {t("sidebar.profile.ecoSummary", {
                    count: snapshot.system.profileManagedCount,
                  })}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Host & Uptime compact footer */}
        {snapshot && (
          <div
            className="px-3 py-2 rounded-xl border text-[11px] flex flex-col gap-0.5"
            style={{
              backgroundColor: "var(--bg-subtle)",
              borderColor: "var(--border-subtle)",
            }}
          >
            <div className="flex items-center justify-between font-medium">
              <span className="flex items-center gap-1.5 truncate">
                <Cpu className="w-3 h-3 opacity-70 shrink-0" />
                <span className="truncate">{snapshot.system.hostname}</span>
              </span>
              <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
            </div>
            <div
              className="flex items-center justify-between tabular-nums"
              style={{ color: "var(--text-muted)" }}
            >
              <span>
                {t("app.uptime", {
                  duration: formatDuration(snapshot.system.uptimeSeconds, language),
                })}
              </span>
              <span className="font-semibold">v{APP_VERSION}</span>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
});

Sidebar.displayName = "Sidebar";
