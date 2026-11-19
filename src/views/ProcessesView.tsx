import React, { useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  GitFork,
  Layers,
  Leaf,
  List,
  Lock,
  Pause,
  Play,
  Search,
  Snowflake,
  Trash2,
  Unlock,
} from "lucide-react";
import { Sparkline } from "../components/charts/Sparkline";
import {
  formatBytes,
  formatSpeed,
  getCategoryMeta,
  getProcessMonogram,
} from "../lib/format";
import { api } from "../lib/tauri";
import {
  ActionResult,
  ProcessCategory,
  ProcessEntry,
} from "../types/telemetry";

interface ProcessesViewProps {
  processes: ProcessEntry[];
  totalMemoryBytes: number;
  selectedPid: number | null;
  onSelectPid: (pid: number) => void;
  onActionFeedback: (res: ActionResult) => void;
}

type ViewMode = "grouped" | "tree" | "flat";
type SortField = "name" | "cpu" | "memory" | "disk";
type CategoryFilter = "all" | ProcessCategory | "high";

interface ProcessGroup {
  key: string;
  category: ProcessCategory;
  cpuPercent: number;
  memoryBytes: number;
  diskBytesPerSec: number;
  items: ProcessEntry[];
}

interface TreeRow {
  proc: ProcessEntry;
  depth: number;
}

export const ProcessesView: React.FC<ProcessesViewProps> = ({
  processes,
  totalMemoryBytes,
  selectedPid,
  onSelectPid,
  onActionFeedback,
}) => {
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("grouped");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [sortField, setSortField] = useState<SortField>("cpu");
  const [sortAsc, setSortAsc] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [manualFreeze, setManualFreeze] = useState(false);
  const [isHoveringTable, setIsHoveringTable] = useState(false);

  // Store frozen order of keys/PIDs so values keep updating live while row positions stay rock-solid!
  const frozenFlatOrderRef = useRef<number[]>([]);
  const frozenGroupOrderRef = useRef<string[]>([]);

  const isOrderFrozen = manualFreeze || isHoveringTable;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return processes.filter((p) => {
      if (categoryFilter === "high") {
        if (p.cpuPercent < 3 && p.memoryBytes < 300 * 1024 * 1024) return false;
      } else if (categoryFilter !== "all" && p.category !== categoryFilter) {
        return false;
      }
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.groupKey.toLowerCase().includes(q) ||
        p.subtitle.toLowerCase().includes(q) ||
        p.cmdLine.toLowerCase().includes(q) ||
        String(p.pid).includes(q)
      );
    });
  }, [processes, search, categoryFilter]);

  const compareProcs = (a: ProcessEntry, b: ProcessEntry) => {
    let cmp = 0;
    if (sortField === "name") cmp = a.name.localeCompare(b.name);
    else if (sortField === "cpu") cmp = a.cpuPercent - b.cpuPercent;
    else if (sortField === "memory") cmp = a.memoryBytes - b.memoryBytes;
    else {
      cmp =
        a.diskReadBytesPerSec +
        a.diskWriteBytesPerSec -
        (b.diskReadBytesPerSec + b.diskWriteBytesPerSec);
    }
    return sortAsc ? cmp : -cmp;
  };

  // Flat sorted list with Hover-Freeze support
  const flatSorted = useMemo(() => {
    const copy = [...filtered];
    if (isOrderFrozen && frozenFlatOrderRef.current.length > 0) {
      const idxMap = new Map(frozenFlatOrderRef.current.map((pid, i) => [pid, i]));
      copy.sort((a, b) => {
        const ia = idxMap.get(a.pid) ?? 999999;
        const ib = idxMap.get(b.pid) ?? 999999;
        return ia - ib;
      });
    } else {
      copy.sort(compareProcs);
      frozenFlatOrderRef.current = copy.map((p) => p.pid);
    }
    return copy;
  }, [filtered, sortField, sortAsc, isOrderFrozen]);

  // Grouped view with Hover-Freeze support
  const grouped = useMemo<ProcessGroup[]>(() => {
    const map = new Map<string, ProcessEntry[]>();
    for (const p of filtered) {
      const list = map.get(p.groupKey) ?? [];
      list.push(p);
      map.set(p.groupKey, list);
    }

    const groups: ProcessGroup[] = [];
    for (const [key, items] of map.entries()) {
      items.sort(compareProcs);
      const cpuPercent = items.reduce((s, x) => s + x.cpuPercent, 0);
      const memoryBytes = items.reduce((s, x) => s + x.memoryBytes, 0);
      const diskBytesPerSec = items.reduce(
        (s, x) => s + x.diskReadBytesPerSec + x.diskWriteBytesPerSec,
        0
      );
      groups.push({
        key,
        category: items[0].category,
        cpuPercent,
        memoryBytes,
        diskBytesPerSec,
        items,
      });
    }

    if (isOrderFrozen && frozenGroupOrderRef.current.length > 0) {
      const idxMap = new Map(frozenGroupOrderRef.current.map((k, i) => [k, i]));
      groups.sort((a, b) => {
        const ia = idxMap.get(a.key) ?? 999999;
        const ib = idxMap.get(b.key) ?? 999999;
        return ia - ib;
      });
    } else {
      groups.sort((a, b) => {
        let cmp = 0;
        if (sortField === "name") cmp = a.key.localeCompare(b.key);
        else if (sortField === "cpu") cmp = a.cpuPercent - b.cpuPercent;
        else if (sortField === "memory") cmp = a.memoryBytes - b.memoryBytes;
        else cmp = a.diskBytesPerSec - b.diskBytesPerSec;
        return sortAsc ? cmp : -cmp;
      });
      frozenGroupOrderRef.current = groups.map((g) => g.key);
    }

    return groups;
  }, [filtered, sortField, sortAsc, isOrderFrozen]);

  // Tree view (Parent -> Child)
  const treeRows = useMemo<TreeRow[]>(() => {
    if (viewMode !== "tree") return [];
    const byPid = new Map(filtered.map((p) => [p.pid, p]));
    const childrenMap = new Map<number, ProcessEntry[]>();
    const roots: ProcessEntry[] = [];

    for (const p of filtered) {
      if (p.parentPid && byPid.has(p.parentPid) && p.parentPid !== p.pid) {
        const list = childrenMap.get(p.parentPid) ?? [];
        list.push(p);
        childrenMap.set(p.parentPid, list);
      } else {
        roots.push(p);
      }
    }

    roots.sort(compareProcs);
    const rows: TreeRow[] = [];
    const visited = new Set<number>();

    const walk = (proc: ProcessEntry, depth: number) => {
      if (visited.has(proc.pid) || depth > 8) return;
      visited.add(proc.pid);
      rows.push({ proc, depth });
      const kids = childrenMap.get(proc.pid);
      if (kids) {
        kids.sort(compareProcs);
        for (const k of kids) walk(k, depth + 1);
      }
    };

    for (const r of roots) walk(r, 0);
    return rows;
  }, [filtered, viewMode, sortField, sortAsc]);

  const toggleSort = (field: SortField) => {
    frozenFlatOrderRef.current = [];
    frozenGroupOrderRef.current = [];
    if (sortField === field) setSortAsc((a) => !a);
    else {
      setSortField(field);
      setSortAsc(field === "name");
    }
  };

  const quickKill = async (e: React.MouseEvent, pid: number) => {
    e.stopPropagation();
    const res = await api.killProcess(pid);
    onActionFeedback(res);
  };

  const quickSuspend = async (e: React.MouseEvent, proc: ProcessEntry) => {
    e.stopPropagation();
    const res = await api.setProcessSuspended(proc.pid, !proc.isSuspended);
    onActionFeedback(res);
  };

  const renderSortIcon = (field: SortField) => {
    if (sortField !== field) return null;
    return sortAsc ? (
      <ArrowUp className="w-3 h-3 inline ml-1" />
    ) : (
      <ArrowDown className="w-3 h-3 inline ml-1" />
    );
  };

  const renderProcessRow = (proc: ProcessEntry, indentPx = 0) => {
    const cat = getCategoryMeta(proc.category);
    const isSelected = selectedPid === proc.pid;
    const diskTotal = proc.diskReadBytesPerSec + proc.diskWriteBytesPerSec;
    const ramPct =
      totalMemoryBytes > 0 ? (proc.memoryBytes / totalMemoryBytes) * 100 : 0;

    return (
      <div
        key={proc.pid}
        onClick={() => onSelectPid(proc.pid)}
        className="group grid grid-cols-[minmax(220px,1fr)_135px_120px_95px_76px] items-center gap-2 px-3.5 py-2 border-b text-xs transition-colors cursor-pointer"
        style={{
          borderColor: "var(--border-subtle)",
          backgroundColor: isSelected
            ? "var(--accent-cpu-soft)"
            : "transparent",
        }}
      >
        {/* Name & Smart Context */}
        <div
          className="flex items-center gap-2.5 min-w-0"
          style={{ paddingLeft: indentPx }}
        >
          {indentPx > 0 && (
            <span
              className="w-3 h-3 border-l border-b rounded-bl shrink-0 -mt-1.5"
              style={{ borderColor: "var(--border-strong)" }}
            />
          )}
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-[10px] shrink-0"
            style={{
              backgroundColor: cat.softBg,
              color: cat.color,
            }}
          >
            {getProcessMonogram(proc.name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold truncate">{proc.name}</span>
              <span
                className="text-[10px] tabular-nums shrink-0"
                style={{ color: "var(--text-muted)" }}
              >
                {proc.pid}
              </span>
              {proc.isSuspended && (
                <Snowflake
                  className="w-3 h-3 text-sky-500 shrink-0"
                  aria-label="Eingefroren"
                />
              )}
              {proc.isEfficiencyMode && (
                <Leaf
                  className="w-3 h-3 text-emerald-500 shrink-0"
                  aria-label="Eco-Modus"
                />
              )}
            </div>
            {proc.subtitle && (
              <div
                className="text-[11px] truncate"
                style={{ color: "var(--text-muted)" }}
              >
                {proc.subtitle}
              </div>
            )}
          </div>
        </div>

        {/* CPU + Inline Sparkline */}
        <div className="flex items-center justify-end gap-2 tabular-nums">
          <Sparkline
            data={proc.cpuHistory}
            color={proc.cpuPercent > 25 ? "#f97316" : "var(--accent-cpu)"}
            width={48}
            height={18}
            maxValue={Math.max(25, ...proc.cpuHistory)}
          />
          <span
            className="font-semibold w-11 text-right"
            style={{
              color:
                proc.cpuPercent > 40
                  ? "var(--accent-danger)"
                  : proc.cpuPercent > 10
                    ? "var(--accent-cpu)"
                    : "var(--text-primary)",
            }}
          >
            {proc.cpuPercent.toFixed(1)}%
          </span>
        </div>

        {/* RAM + Mini Bar */}
        <div className="flex flex-col items-end gap-1 tabular-nums">
          <span className="font-medium">{formatBytes(proc.memoryBytes)}</span>
          <div
            className="w-20 h-1 rounded-full overflow-hidden"
            style={{ backgroundColor: "var(--bg-subtle)" }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(100, Math.max(2, ramPct * 3))}%`,
                backgroundColor: "var(--accent-ram)",
              }}
            />
          </div>
        </div>

        {/* Disk */}
        <div
          className="text-right tabular-nums"
          style={{
            color:
              diskTotal > 1024 * 1024
                ? "var(--accent-disk)"
                : "var(--text-secondary)",
          }}
        >
          {diskTotal > 1024 ? formatSpeed(diskTotal) : "–"}
        </div>

        {/* Hover Quick Actions */}
        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => quickSuspend(e, proc)}
            className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer hover:bg-[var(--bg-surface-active)]"
            style={{ color: "var(--accent-cpu)" }}
            title={proc.isSuspended ? "Fortsetzen" : "Einfrieren (Pause)"}
          >
            {proc.isSuspended ? (
              <Play className="w-3.5 h-3.5" />
            ) : (
              <Pause className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            onClick={(e) => quickKill(e, proc.pid)}
            className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer hover:bg-red-500/20 text-red-500"
            title="Prozess beenden"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        {/* Search */}
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-xl border flex-1 min-w-[220px] max-w-md"
          style={{
            backgroundColor: "var(--bg-surface)",
            borderColor: "var(--border-subtle)",
          }}
        >
          <Search className="w-4 h-4 shrink-0" style={{ color: "var(--text-muted)" }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Prozess, PID, Skript oder Pfad filtern…"
            className="bg-transparent outline-none text-xs flex-1"
            style={{ color: "var(--text-primary)" }}
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="text-[11px] cursor-pointer"
              style={{ color: "var(--text-muted)" }}
            >
              ×
            </button>
          )}
        </div>

        {/* Right Controls: View Mode + Hover-Freeze Indicator */}
        <div className="flex items-center gap-2">
          {/* Freeze indicator / manual toggle */}
          <button
            onClick={() => setManualFreeze((f) => !f)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium border cursor-pointer transition-all"
            style={{
              backgroundColor: isOrderFrozen
                ? "var(--accent-cpu-soft)"
                : "var(--bg-surface)",
              borderColor: isOrderFrozen
                ? "var(--accent-cpu)"
                : "var(--border-subtle)",
              color: isOrderFrozen
                ? "var(--accent-cpu)"
                : "var(--text-secondary)",
            }}
            title="Reihenfolge friert beim Hovern automatisch ein – klicken zum dauerhaften Fixieren"
          >
            {isOrderFrozen ? (
              <Lock className="w-3.5 h-3.5" />
            ) : (
              <Unlock className="w-3.5 h-3.5" />
            )}
            <span>
              {manualFreeze
                ? "Fixiert"
                : isHoveringTable
                  ? "Hover-Pause"
                  : "Auto-Sort"}
            </span>
          </button>

          {/* View Mode Segmented Control */}
          <div
            className="flex items-center p-1 rounded-xl border gap-0.5"
            style={{
              backgroundColor: "var(--bg-surface)",
              borderColor: "var(--border-subtle)",
            }}
          >
            {(
              [
                { id: "grouped", label: "Gruppiert", icon: <Layers className="w-3.5 h-3.5" /> },
                { id: "tree", label: "Baum", icon: <GitFork className="w-3.5 h-3.5" /> },
                { id: "flat", label: "Liste", icon: <List className="w-3.5 h-3.5" /> },
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                onClick={() => setViewMode(m.id)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors cursor-pointer"
                style={{
                  backgroundColor:
                    viewMode === m.id ? "var(--bg-surface-active)" : "transparent",
                  color:
                    viewMode === m.id
                      ? "var(--text-primary)"
                      : "var(--text-muted)",
                }}
              >
                {m.icon}
                <span className="hidden sm:inline">{m.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Category Filter Pills */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {(
          [
            { id: "all", label: `Alle (${processes.length})`, color: "var(--accent-cpu)" },
            { id: "high", label: "Hohe Last", color: "#ef4444" },
            { id: "browser", label: "Browser", color: "#0ea5e9" },
            { id: "dev", label: "Dev-Tools", color: "#8b5cf6" },
            { id: "app", label: "Apps", color: "#ec4899" },
            { id: "game", label: "Games/3D", color: "#10b981" },
            { id: "background", label: "Hintergrund", color: "#f59e0b" },
            { id: "system", label: "System", color: "#64748b" },
          ] as const
        ).map((pill) => {
          const active = categoryFilter === pill.id;
          return (
            <button
              key={pill.id}
              onClick={() => {
                frozenFlatOrderRef.current = [];
                frozenGroupOrderRef.current = [];
                setCategoryFilter(pill.id);
              }}
              className="px-2.5 py-1 rounded-full text-xs font-medium transition-all cursor-pointer border"
              style={{
                backgroundColor: active ? `${pill.color}22` : "var(--bg-surface)",
                borderColor: active ? `${pill.color}66` : "var(--border-subtle)",
                color: active ? pill.color : "var(--text-secondary)",
              }}
            >
              {pill.label}
            </button>
          );
        })}
      </div>

      {/* Process Table */}
      <div
        onMouseEnter={() => setIsHoveringTable(true)}
        onMouseLeave={() => setIsHoveringTable(false)}
        className="fluent-card flex-1 flex flex-col overflow-hidden"
      >
        {/* Table Header */}
        <div
          className="grid grid-cols-[minmax(220px,1fr)_135px_120px_95px_76px] items-center gap-2 px-3.5 py-2.5 border-b text-[11px] font-semibold uppercase tracking-wider shrink-0"
          style={{
            borderColor: "var(--border-subtle)",
            backgroundColor: "var(--bg-subtle)",
            color: "var(--text-muted)",
          }}
        >
          <button
            onClick={() => toggleSort("name")}
            className="text-left cursor-pointer hover:text-[var(--text-primary)]"
          >
            Prozess / Kontext {renderSortIcon("name")}
          </button>
          <button
            onClick={() => toggleSort("cpu")}
            className="text-right cursor-pointer hover:text-[var(--text-primary)]"
          >
            CPU (30s) {renderSortIcon("cpu")}
          </button>
          <button
            onClick={() => toggleSort("memory")}
            className="text-right cursor-pointer hover:text-[var(--text-primary)]"
          >
            RAM {renderSortIcon("memory")}
          </button>
          <button
            onClick={() => toggleSort("disk")}
            className="text-right cursor-pointer hover:text-[var(--text-primary)]"
          >
            Disk I/O {renderSortIcon("disk")}
          </button>
          <span className="text-right">Aktion</span>
        </div>

        {/* Table Body */}
        <div className="flex-1 overflow-y-auto">
          {viewMode === "grouped" &&
            grouped.map((g) => {
              if (g.items.length === 1) {
                return renderProcessRow(g.items[0], 0);
              }
              const expanded = !!expandedGroups[g.key];
              const cat = getCategoryMeta(g.category);
              const ramPct =
                totalMemoryBytes > 0
                  ? (g.memoryBytes / totalMemoryBytes) * 100
                  : 0;

              return (
                <React.Fragment key={g.key}>
                  <div
                    onClick={() =>
                      setExpandedGroups((prev) => ({
                        ...prev,
                        [g.key]: !prev[g.key],
                      }))
                    }
                    className="grid grid-cols-[minmax(220px,1fr)_135px_120px_95px_76px] items-center gap-2 px-3.5 py-2 border-b text-xs transition-colors cursor-pointer hover:bg-[var(--bg-surface-hover)]"
                    style={{ borderColor: "var(--border-subtle)" }}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span style={{ color: "var(--text-muted)" }}>
                        {expanded ? (
                          <ChevronDown className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5" />
                        )}
                      </span>
                      <div
                        className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-[10px] shrink-0"
                        style={{
                          backgroundColor: cat.softBg,
                          color: cat.color,
                        }}
                      >
                        {getProcessMonogram(g.key)}
                      </div>
                      <div className="min-w-0 flex items-center gap-2">
                        <span className="font-semibold truncate">{g.key}</span>
                        <span
                          className="text-[10px] font-bold px-1.5 py-0.5 rounded-md tabular-nums shrink-0"
                          style={{
                            backgroundColor: cat.softBg,
                            color: cat.color,
                          }}
                        >
                          {g.items.length}
                        </span>
                      </div>
                    </div>

                    <div
                      className="text-right font-semibold tabular-nums"
                      style={{
                        color:
                          g.cpuPercent > 40
                            ? "var(--accent-danger)"
                            : g.cpuPercent > 10
                              ? "var(--accent-cpu)"
                              : "var(--text-primary)",
                      }}
                    >
                      {g.cpuPercent.toFixed(1)}%
                    </div>

                    <div className="flex flex-col items-end gap-1 tabular-nums">
                      <span className="font-semibold">
                        {formatBytes(g.memoryBytes)}
                      </span>
                      <div
                        className="w-20 h-1 rounded-full overflow-hidden"
                        style={{ backgroundColor: "var(--bg-subtle)" }}
                      >
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.min(100, Math.max(2, ramPct * 3))}%`,
                            backgroundColor: "var(--accent-ram)",
                          }}
                        />
                      </div>
                    </div>

                    <div
                      className="text-right tabular-nums"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {g.diskBytesPerSec > 1024
                        ? formatSpeed(g.diskBytesPerSec)
                        : "–"}
                    </div>

                    <div
                      className="text-right text-[11px]"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {expanded ? "Zuklappen" : "Details"}
                    </div>
                  </div>

                  {expanded &&
                    g.items.map((child) => renderProcessRow(child, 24))}
                </React.Fragment>
              );
            })}

          {viewMode === "flat" && flatSorted.map((p) => renderProcessRow(p, 0))}

          {viewMode === "tree" &&
            treeRows.map((row) => renderProcessRow(row.proc, row.depth * 18))}
        </div>
      </div>
    </div>
  );
};
