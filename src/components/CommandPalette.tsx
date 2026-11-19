import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  Flame,
  LayoutDashboard,
  Leaf,
  ListTree,
  Monitor,
  Moon,
  Network,
  PictureInPicture2,
  RefreshCw,
  Search,
  Sun,
  Trash2,
  Wrench,
} from "lucide-react";
import { formatBytes, getCategoryMeta } from "../lib/format";
import { api } from "../lib/tauri";
import {
  ActionResult,
  NavTab,
  NetworkConnectionEntry,
  ProcessEntry,
  ThemePreference,
} from "../types/telemetry";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  processes: ProcessEntry[];
  onNavigate: (tab: NavTab) => void;
  onInspectPid: (pid: number) => void;
  onSetTheme: (pref: ThemePreference) => void;
  onEnterMiniHud: () => void;
  onApplyProfile: (profile: "normal" | "eco" | "gaming") => void;
  onActionFeedback: (res: ActionResult) => void;
}

interface PaletteItem {
  id: string;
  group: string;
  title: string;
  subtitle?: string;
  badge?: string;
  badgeColor?: string;
  icon: React.ReactNode;
  run: () => void;
  secondaryAction?: {
    label: string;
    run: () => void;
  };
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onClose,
  processes,
  onNavigate,
  onInspectPid,
  onSetTheme,
  onEnterMiniHud,
  onApplyProfile,
  onActionFeedback,
}) => {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [ports, setPorts] = useState<NetworkConnectionEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
    setTimeout(() => inputRef.current?.focus(), 20);
    api
      .getNetworkConnections()
      .then((list) => setPorts(list.filter((c) => c.state === "LISTENING")))
      .catch(() => {});
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase();
    const out: PaletteItem[] = [];

    // Port search mode (e.g. ":3000" or numeric)
    if (q.startsWith(":") || /^\d{2,5}$/.test(q)) {
      const portStr = q.replace(/^:/, "");
      const matchingPorts = ports
        .filter((p) => String(p.localPort).includes(portStr))
        .slice(0, 8);

      for (const p of matchingPorts) {
        out.push({
          id: `port-${p.protocol}-${p.localPort}-${p.pid}`,
          group: "Offene Ports",
          title: `Port :${p.localPort} (${p.protocol}) — ${p.processName}`,
          subtitle: `PID ${p.pid}${p.processSubtitle ? ` • ${p.processSubtitle}` : ""}`,
          badge: "Port",
          badgeColor: "var(--accent-net)",
          icon: <Network className="w-4 h-4 text-rose-500" />,
          run: () => {
            onNavigate("processes");
            onInspectPid(p.pid);
            onClose();
          },
          secondaryAction: {
            label: "Kill",
            run: async () => {
              const res = await api.killProcess(p.pid);
              onActionFeedback(res);
              onClose();
            },
          },
        });
      }
    }

    // Processes
    const matchingProcs = processes
      .filter((p) => {
        if (!q) return p.cpuPercent > 1 || p.memoryBytes > 120 * 1024 * 1024;
        return (
          p.name.toLowerCase().includes(q) ||
          p.subtitle.toLowerCase().includes(q) ||
          String(p.pid).includes(q)
        );
      })
      .sort((a, b) => b.cpuPercent - a.cpuPercent || b.memoryBytes - a.memoryBytes)
      .slice(0, q ? 8 : 4);

    for (const p of matchingProcs) {
      const cat = getCategoryMeta(p.category);
      out.push({
        id: `proc-${p.pid}`,
        group: "Prozesse",
        title: p.name,
        subtitle: `PID ${p.pid} • ${p.cpuPercent.toFixed(1)}% CPU • ${formatBytes(p.memoryBytes)}${p.subtitle ? ` • ${p.subtitle}` : ""}`,
        badge: cat.label,
        badgeColor: cat.color,
        icon: <ListTree className="w-4 h-4" style={{ color: cat.color }} />,
        run: () => {
          onNavigate("processes");
          onInspectPid(p.pid);
          onClose();
        },
        secondaryAction: {
          label: "Kill",
          run: async () => {
            const res = await api.killProcess(p.pid);
            onActionFeedback(res);
            onClose();
          },
        },
      });
    }

    // Navigation & Quick Actions
    const actions: PaletteItem[] = [
      {
        id: "nav-overview",
        group: "Ansichten",
        title: "Übersicht (Pulse Dashboard)",
        icon: <LayoutDashboard className="w-4 h-4 text-sky-500" />,
        run: () => {
          onNavigate("overview");
          onClose();
        },
      },
      {
        id: "nav-processes",
        group: "Ansichten",
        title: "Prozesse verwalten",
        icon: <ListTree className="w-4 h-4 text-violet-500" />,
        run: () => {
          onNavigate("processes");
          onClose();
        },
      },
      {
        id: "nav-performance",
        group: "Ansichten",
        title: "Performance & Spike-Historie",
        icon: <Activity className="w-4 h-4 text-emerald-500" />,
        run: () => {
          onNavigate("performance");
          onClose();
        },
      },
      {
        id: "nav-network",
        group: "Ansichten",
        title: "Netzwerk & Offene Ports",
        icon: <Network className="w-4 h-4 text-rose-500" />,
        run: () => {
          onNavigate("network");
          onClose();
        },
      },
      {
        id: "nav-tools",
        group: "Ansichten",
        title: "System & Tools (Autostart, Dienste, File Lock)",
        icon: <Wrench className="w-4 h-4 text-amber-500" />,
        run: () => {
          onNavigate("tools");
          onClose();
        },
      },
      {
        id: "act-hud",
        group: "Schnellaktionen",
        title: "Kompaktes Mini-HUD aktivieren",
        subtitle: "Always-on-Top schwebende Systemanzeige",
        icon: <PictureInPicture2 className="w-4 h-4 text-sky-500" />,
        run: () => {
          onClose();
          onEnterMiniHud();
        },
      },
      {
        id: "act-explorer",
        group: "Schnellaktionen",
        title: "Windows Explorer neu starten",
        subtitle: "Hilft bei hängender Taskleiste oder Desktop",
        icon: <RefreshCw className="w-4 h-4 text-amber-500" />,
        run: async () => {
          onClose();
          const res = await api.restartExplorer();
          onActionFeedback(res);
        },
      },
      {
        id: "act-eco",
        group: "Schnellaktionen",
        title: "Eco-Profil aktivieren",
        subtitle: "Hintergrundprozesse in Efficiency Mode setzen",
        icon: <Leaf className="w-4 h-4 text-emerald-500" />,
        run: () => {
          onApplyProfile("eco");
          onClose();
        },
      },
      {
        id: "act-gaming",
        group: "Schnellaktionen",
        title: "Boost / Gaming-Profil aktivieren",
        subtitle: "Priorisiert Spiele, drosselt Hintergrundtasks",
        icon: <Flame className="w-4 h-4 text-orange-500" />,
        run: () => {
          onApplyProfile("gaming");
          onClose();
        },
      },
      {
        id: "theme-system",
        group: "Design",
        title: "Design: Systemstandard",
        icon: <Monitor className="w-4 h-4" />,
        run: () => {
          onSetTheme("system");
          onClose();
        },
      },
      {
        id: "theme-light",
        group: "Design",
        title: "Design: Hell (Light Mode)",
        icon: <Sun className="w-4 h-4 text-amber-500" />,
        run: () => {
          onSetTheme("light");
          onClose();
        },
      },
      {
        id: "theme-dark",
        group: "Design",
        title: "Design: Dunkel (Dark Mode)",
        icon: <Moon className="w-4 h-4 text-indigo-400" />,
        run: () => {
          onSetTheme("dark");
          onClose();
        },
      },
    ];

    for (const act of actions) {
      if (
        !q ||
        act.title.toLowerCase().includes(q) ||
        act.subtitle?.toLowerCase().includes(q) ||
        act.group.toLowerCase().includes(q)
      ) {
        out.push(act);
      }
    }

    return out;
  }, [
    query,
    processes,
    ports,
    onNavigate,
    onInspectPid,
    onSetTheme,
    onEnterMiniHud,
    onApplyProfile,
    onActionFeedback,
    onClose,
  ]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && items[selectedIndex]) {
      e.preventDefault();
      items[selectedIndex].run();
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
          className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4"
          style={{
            backgroundColor: "rgba(0, 0, 0, 0.42)",
            backdropFilter: "blur(6px)",
          }}
        >
          <motion.div
            initial={{ opacity: 0, y: -14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 460, damping: 34 }}
            onKeyDown={handleKeyDown}
            className="w-full max-w-xl rounded-2xl border overflow-hidden flex flex-col"
            style={{
              backgroundColor: "var(--bg-drawer)",
              borderColor: "var(--border-strong)",
              boxShadow: "var(--shadow-float)",
            }}
          >
            {/* Search Bar */}
            <div
              className="flex items-center gap-3 px-4 py-3.5 border-b"
              style={{ borderColor: "var(--border-subtle)" }}
            >
              <Search className="w-4 h-4 shrink-0" style={{ color: "var(--accent-cpu)" }} />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Prozess suchen, Port eintippen (z. B. :3000) oder Befehl ausführen…"
                className="flex-1 bg-transparent outline-none text-sm"
                style={{ color: "var(--text-primary)" }}
              />
              <kbd
                className="px-1.5 py-0.5 text-[10px] rounded font-mono"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  color: "var(--text-muted)",
                }}
              >
                ESC
              </kbd>
            </div>

            {/* Results */}
            <div className="max-h-96 overflow-y-auto p-2 flex flex-col gap-0.5">
              {items.length === 0 ? (
                <div
                  className="py-10 text-center text-sm"
                  style={{ color: "var(--text-muted)" }}
                >
                  Keine passenden Prozesse, Ports oder Aktionen gefunden.
                </div>
              ) : (
                items.map((item, idx) => {
                  const active = idx === selectedIndex;
                  const showGroupHeader =
                    idx === 0 || items[idx - 1].group !== item.group;
                  return (
                    <React.Fragment key={item.id}>
                      {showGroupHeader && (
                        <div
                          className="text-[10px] font-semibold uppercase tracking-wider px-2.5 pt-2 pb-1"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {item.group}
                        </div>
                      )}
                      <div
                        onMouseEnter={() => setSelectedIndex(idx)}
                        onClick={item.run}
                        className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-xl cursor-pointer transition-colors"
                        style={{
                          backgroundColor: active
                            ? "var(--bg-surface-active)"
                            : "transparent",
                        }}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="shrink-0">{item.icon}</span>
                          <div className="min-w-0">
                            <div className="text-sm font-medium truncate">
                              {item.title}
                            </div>
                            {item.subtitle && (
                              <div
                                className="text-[11px] truncate tabular-nums"
                                style={{ color: "var(--text-muted)" }}
                              >
                                {item.subtitle}
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          {item.secondaryAction && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                item.secondaryAction?.run();
                              }}
                              className="px-2 py-1 rounded-lg text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                              style={{
                                backgroundColor: "var(--accent-danger-soft)",
                                color: "var(--accent-danger)",
                              }}
                              title="Prozess sofort beenden"
                            >
                              <Trash2 className="w-3 h-3" />
                              {item.secondaryAction.label}
                            </button>
                          )}
                          {item.badge && (
                            <span
                              className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md"
                              style={{
                                backgroundColor: "var(--bg-subtle)",
                                color: item.badgeColor ?? "var(--text-secondary)",
                              }}
                            >
                              {item.badge}
                            </span>
                          )}
                        </div>
                      </div>
                    </React.Fragment>
                  );
                })
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
