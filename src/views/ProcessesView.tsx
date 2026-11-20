import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Crosshair,
  Download,
  Eye,
  FolderOpen,
  GitFork,
  Layers,
  Leaf,
  List,
  Lock,
  Minimize2,
  Pause,
  Play,
  RotateCw,
  Search,
  Skull,
  Snowflake,
  Trash2,
  Unlock,
} from "lucide-react";
import { Sparkline } from "../components/charts/Sparkline";
import {
  getCachedProcessIcon,
  useProcessIcons,
} from "../hooks/useProcessIcons";
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
  searchFocusNonce?: number;
  pickingWindow?: boolean;
  onPickWindow?: () => void;
  onSelectPid: (pid: number) => void;
  onActionFeedback: (res: ActionResult) => void;
}

type ViewMode = "grouped" | "tree" | "flat";
type SortField = "name" | "cpu" | "gpu" | "memory" | "disk";
type CategoryFilter = "all" | ProcessCategory | "high";

interface ProcessGroup {
  key: string;
  category: ProcessCategory;
  cpuPercent: number;
  gpuPercent: number;
  memoryBytes: number;
  diskBytesPerSec: number;
  items: ProcessEntry[];
}

interface TreeRow {
  proc: ProcessEntry;
  depth: number;
}

type DisplayRow =
  | { kind: "process"; proc: ProcessEntry; indentPx: number; key: string }
  | { kind: "group"; group: ProcessGroup; expanded: boolean; key: string };

interface ContextMenuState {
  proc: ProcessEntry;
  x: number;
  y: number;
}

const ROW_HEIGHT = 48;
const OVERSCAN = 6;
const GRID_COLS =
  "grid-cols-[minmax(200px,1fr)_128px_68px_112px_88px_72px]";

interface ProcessRowItemProps {
  proc: ProcessEntry;
  indentPx: number;
  totalMemoryBytes: number;
  isSelected: boolean;
  iconUri?: string | null;
  onSelectPid: (pid: number) => void;
  onContextMenu: (e: React.MouseEvent, proc: ProcessEntry) => void;
  onQuickSuspend: (e: React.MouseEvent, proc: ProcessEntry) => void;
  onQuickKill: (e: React.MouseEvent, pid: number) => void;
}

const ProcessRowItem: React.FC<ProcessRowItemProps> = React.memo(
  ({
    proc,
    indentPx,
    totalMemoryBytes,
    isSelected,
    iconUri,
    onSelectPid,
    onContextMenu,
    onQuickSuspend,
    onQuickKill,
  }) => {
    const cat = getCategoryMeta(proc.category);
    const diskTotal = proc.diskReadBytesPerSec + proc.diskWriteBytesPerSec;
    const ramPct =
      totalMemoryBytes > 0 ? (proc.memoryBytes / totalMemoryBytes) * 100 : 0;

    let maxHist = 25;
    let sumHist = 0;
    for (let i = 0; i < proc.cpuHistory.length; i++) {
      const v = proc.cpuHistory[i];
      if (v > maxHist) maxHist = v;
      sumHist += v;
    }
    const avg30s =
      proc.cpuHistory.length > 0 ? sumHist / proc.cpuHistory.length : proc.cpuPercent;

    return (
      <div
        onClick={() => onSelectPid(proc.pid)}
        onContextMenu={(e) => onContextMenu(e, proc)}
        className={`group h-[48px] box-border grid ${GRID_COLS} items-center gap-2 px-3.5 border-b text-xs transition-colors cursor-pointer`}
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
            className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-[10px] shrink-0 overflow-hidden"
            style={{
              backgroundColor: iconUri ? "var(--bg-subtle)" : cat.softBg,
              color: cat.color,
            }}
          >
            {iconUri ? (
              <img
                src={iconUri}
                alt=""
                className="w-[18px] h-[18px] object-contain"
                draggable={false}
              />
            ) : (
              getProcessMonogram(proc.name)
            )}
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
        <div
          className="flex items-center justify-end gap-2 tabular-nums"
          title={`Aktuell: ${proc.cpuPercent.toFixed(1)}% · Ø 30s: ${avg30s.toFixed(1)}%`}
        >
          <Sparkline
            data={proc.cpuHistory}
            color={proc.cpuPercent > 25 ? "#f97316" : "var(--accent-cpu)"}
            width={44}
            height={18}
            maxValue={maxHist}
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

        {/* GPU % */}
        <div
          className="text-right tabular-nums font-medium"
          style={{
            color:
              proc.gpuPercent > 25
                ? "var(--accent-gpu)"
                : proc.gpuPercent > 0.5
                  ? "var(--text-primary)"
                  : "var(--text-muted)",
          }}
        >
          {proc.gpuPercent > 0.05 ? `${proc.gpuPercent.toFixed(1)}%` : "–"}
        </div>

        {/* RAM + Mini Bar */}
        <div className="flex flex-col items-end gap-1 tabular-nums">
          <span className="font-medium">{formatBytes(proc.memoryBytes)}</span>
          <div
            className="w-20 h-1 rounded-full overflow-hidden"
            style={{ backgroundColor: "var(--bg-subtle)" }}
          >
            <div
              className="h-full w-full rounded-full origin-left"
              style={{
                transform: `scaleX(${Math.min(1, Math.max(0.02, (ramPct * 3) / 100))})`,
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
            onClick={(e) => onQuickSuspend(e, proc)}
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
            onClick={(e) => onQuickKill(e, proc.pid)}
            className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer hover:bg-red-500/20 text-red-500"
            title="Prozess beenden"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  }
);

ProcessRowItem.displayName = "ProcessRowItem";

interface GroupRowItemProps {
  group: ProcessGroup;
  expanded: boolean;
  totalMemoryBytes: number;
  iconUri?: string | null;
  onToggleGroup: (key: string) => void;
}

const GroupRowItem: React.FC<GroupRowItemProps> = React.memo(
  ({ group, expanded, totalMemoryBytes, iconUri, onToggleGroup }) => {
    const cat = getCategoryMeta(group.category);
    const ramPct =
      totalMemoryBytes > 0 ? (group.memoryBytes / totalMemoryBytes) * 100 : 0;

    return (
      <div
        onClick={() => onToggleGroup(group.key)}
        className={`h-[48px] box-border grid ${GRID_COLS} items-center gap-2 px-3.5 border-b text-xs transition-colors cursor-pointer hover:bg-[var(--bg-surface-hover)]`}
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
            className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-[10px] shrink-0 overflow-hidden"
            style={{
              backgroundColor: iconUri ? "var(--bg-subtle)" : cat.softBg,
              color: cat.color,
            }}
          >
            {iconUri ? (
              <img
                src={iconUri}
                alt=""
                className="w-[18px] h-[18px] object-contain"
                draggable={false}
              />
            ) : (
              getProcessMonogram(group.key)
            )}
          </div>
          <div className="min-w-0 flex items-center gap-2">
            <span className="font-semibold truncate">{group.key}</span>
            <span
              className="text-[10px] font-bold px-1.5 py-0.5 rounded-md tabular-nums shrink-0"
              style={{
                backgroundColor: cat.softBg,
                color: cat.color,
              }}
            >
              {group.items.length}
            </span>
          </div>
        </div>

        <div
          className="text-right font-semibold tabular-nums"
          style={{
            color:
              group.cpuPercent > 40
                ? "var(--accent-danger)"
                : group.cpuPercent > 10
                  ? "var(--accent-cpu)"
                  : "var(--text-primary)",
          }}
        >
          {group.cpuPercent.toFixed(1)}%
        </div>

        <div
          className="text-right font-semibold tabular-nums"
          style={{
            color:
              group.gpuPercent > 25
                ? "var(--accent-gpu)"
                : group.gpuPercent > 0.5
                  ? "var(--text-primary)"
                  : "var(--text-muted)",
          }}
        >
          {group.gpuPercent > 0.05 ? `${group.gpuPercent.toFixed(1)}%` : "–"}
        </div>

        <div className="flex flex-col items-end gap-1 tabular-nums">
          <span className="font-semibold">{formatBytes(group.memoryBytes)}</span>
          <div
            className="w-20 h-1 rounded-full overflow-hidden"
            style={{ backgroundColor: "var(--bg-subtle)" }}
          >
            <div
              className="h-full w-full rounded-full origin-left"
              style={{
                transform: `scaleX(${Math.min(1, Math.max(0.02, (ramPct * 3) / 100))})`,
                backgroundColor: "var(--accent-ram)",
              }}
            />
          </div>
        </div>

        <div
          className="text-right tabular-nums"
          style={{ color: "var(--text-secondary)" }}
        >
          {group.diskBytesPerSec > 1024 ? formatSpeed(group.diskBytesPerSec) : "–"}
        </div>

        <div
          className="text-right text-[11px]"
          style={{ color: "var(--text-muted)" }}
        >
          {expanded ? "Zuklappen" : "Details"}
        </div>
      </div>
    );
  }
);

GroupRowItem.displayName = "GroupRowItem";

export const ProcessesView: React.FC<ProcessesViewProps> = React.memo(
  ({
    processes,
    totalMemoryBytes,
    selectedPid,
    searchFocusNonce = 0,
    pickingWindow = false,
    onPickWindow,
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
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

    const searchInputRef = useRef<HTMLInputElement>(null);
    const contextMenuRef = useRef<HTMLDivElement>(null);

    // Virtualization scroll state
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(600);

    // Store frozen order of keys/PIDs so values keep updating live while row positions stay rock-solid!
    const frozenFlatOrderRef = useRef<number[]>([]);
    const frozenGroupOrderRef = useRef<string[]>([]);

    const isOrderFrozen = manualFreeze || isHoveringTable || contextMenu !== null;

    // Ctrl+F focus trigger
    useEffect(() => {
      if (searchFocusNonce > 0) {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    }, [searchFocusNonce]);

    // Close context menu on outside click or Escape
    useEffect(() => {
      if (!contextMenu) return;
      const onDown = (e: MouseEvent) => {
        if (
          contextMenuRef.current &&
          !contextMenuRef.current.contains(e.target as Node)
        ) {
          setContextMenu(null);
        }
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") setContextMenu(null);
      };
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
      return () => {
        window.removeEventListener("mousedown", onDown);
        window.removeEventListener("keydown", onKey);
      };
    }, [contextMenu]);

    useEffect(() => {
      const el = scrollContainerRef.current;
      if (!el) return;
      const updateHeight = () => {
        if (el.clientHeight > 0) setViewportHeight(el.clientHeight);
      };
      updateHeight();
      const ro = new ResizeObserver(updateHeight);
      ro.observe(el);
      return () => ro.disconnect();
    }, []);

    const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
      setScrollTop(e.currentTarget.scrollTop);
      setContextMenu((prev) => (prev ? null : prev));
    }, []);

    const handleRowContextMenu = useCallback(
      (e: React.MouseEvent, proc: ProcessEntry) => {
        e.preventDefault();
        const menuW = 216;
        const menuH = 310;
        const x = Math.max(8, Math.min(e.clientX, window.innerWidth - menuW - 8));
        const y = Math.max(8, Math.min(e.clientY, window.innerHeight - menuH - 8));
        setContextMenu({ proc, x, y });
      },
      []
    );

    const filtered = useMemo(() => {
      const q = search.trim().toLowerCase();
      return processes.filter((p) => {
        if (categoryFilter === "high") {
          if (
            p.cpuPercent < 3 &&
            p.gpuPercent < 5 &&
            p.memoryBytes < 300 * 1024 * 1024
          ) {
            return false;
          }
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

    const compareProcs = useCallback(
      (a: ProcessEntry, b: ProcessEntry) => {
        let cmp = 0;
        if (sortField === "name") cmp = a.name.localeCompare(b.name);
        else if (sortField === "cpu") cmp = a.cpuPercent - b.cpuPercent;
        else if (sortField === "gpu") cmp = a.gpuPercent - b.gpuPercent;
        else if (sortField === "memory") cmp = a.memoryBytes - b.memoryBytes;
        else {
          cmp =
            a.diskReadBytesPerSec +
            a.diskWriteBytesPerSec -
            (b.diskReadBytesPerSec + b.diskWriteBytesPerSec);
        }
        return sortAsc ? cmp : -cmp;
      },
      [sortField, sortAsc]
    );

    // Flat sorted list — only computed when viewMode === "flat"
    const flatSorted = useMemo(() => {
      if (viewMode !== "flat") return [];
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
    }, [filtered, viewMode, compareProcs, isOrderFrozen]);

    // Grouped view — only computed when viewMode === "grouped"; child items are sorted only when expanded
    const grouped = useMemo<ProcessGroup[]>(() => {
      if (viewMode !== "grouped") return [];
      const map = new Map<string, ProcessEntry[]>();
      for (const p of filtered) {
        const list = map.get(p.groupKey);
        if (list) list.push(p);
        else map.set(p.groupKey, [p]);
      }

      const groups: ProcessGroup[] = [];
      for (const [key, items] of map.entries()) {
        let cpuPercent = 0;
        let gpuPercent = 0;
        let memoryBytes = 0;
        let diskBytesPerSec = 0;
        for (let i = 0; i < items.length; i++) {
          const x = items[i];
          cpuPercent += x.cpuPercent;
          gpuPercent += x.gpuPercent;
          memoryBytes += x.memoryBytes;
          diskBytesPerSec += x.diskReadBytesPerSec + x.diskWriteBytesPerSec;
        }
        groups.push({
          key,
          category: items[0].category,
          cpuPercent,
          gpuPercent,
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
          else if (sortField === "gpu") cmp = a.gpuPercent - b.gpuPercent;
          else if (sortField === "memory") cmp = a.memoryBytes - b.memoryBytes;
          else cmp = a.diskBytesPerSec - b.diskBytesPerSec;
          return sortAsc ? cmp : -cmp;
        });
        frozenGroupOrderRef.current = groups.map((g) => g.key);
      }

      return groups;
    }, [filtered, viewMode, sortField, sortAsc, isOrderFrozen]);

    // Tree view — only computed when viewMode === "tree"
    const treeRows = useMemo<TreeRow[]>(() => {
      if (viewMode !== "tree") return [];
      const byPid = new Map(filtered.map((p) => [p.pid, p]));
      const childrenMap = new Map<number, ProcessEntry[]>();
      const roots: ProcessEntry[] = [];

      for (const p of filtered) {
        if (p.parentPid && byPid.has(p.parentPid) && p.parentPid !== p.pid) {
          const list = childrenMap.get(p.parentPid);
          if (list) list.push(p);
          else childrenMap.set(p.parentPid, [p]);
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
    }, [filtered, viewMode, compareProcs]);

    // Unified flat display row list for virtualization across all 3 view modes
    const displayRows = useMemo<DisplayRow[]>(() => {
      if (viewMode === "flat") {
        return flatSorted.map((proc) => ({
          kind: "process",
          proc,
          indentPx: 0,
          key: `p-${proc.pid}`,
        }));
      }
      if (viewMode === "tree") {
        return treeRows.map((row) => ({
          kind: "process",
          proc: row.proc,
          indentPx: row.depth * 18,
          key: `t-${row.proc.pid}`,
        }));
      }

      const rows: DisplayRow[] = [];
      for (const g of grouped) {
        if (g.items.length === 1) {
          rows.push({
            kind: "process",
            proc: g.items[0],
            indentPx: 0,
            key: `p-${g.items[0].pid}`,
          });
        } else {
          const expanded = !!expandedGroups[g.key];
          rows.push({
            kind: "group",
            group: g,
            expanded,
            key: `g-${g.key}`,
          });
          if (expanded) {
            const sortedKids = [...g.items].sort(compareProcs);
            for (const child of sortedKids) {
              rows.push({
                kind: "process",
                proc: child,
                indentPx: 24,
                key: `p-${child.pid}`,
              });
            }
          }
        }
      }
      return rows;
    }, [viewMode, flatSorted, treeRows, grouped, expandedGroups, compareProcs]);

    const totalHeight = displayRows.length * ROW_HEIGHT;
    const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const endIndex = Math.min(
      displayRows.length,
      Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN
    );
    const visibleRows = displayRows.slice(startIndex, endIndex);
    const offsetY = startIndex * ROW_HEIGHT;

    // Fetch native app icons ONLY for currently visible virtualized rows
    const visibleExePaths = useMemo(() => {
      const paths: string[] = [];
      for (let i = 0; i < visibleRows.length; i++) {
        const r = visibleRows[i];
        const exe =
          r.kind === "group" ? r.group.items[0]?.exePath : r.proc.exePath;
        if (exe) paths.push(exe);
      }
      return paths;
    }, [visibleRows]);
    useProcessIcons(visibleExePaths);

    const toggleSort = (field: SortField) => {
      frozenFlatOrderRef.current = [];
      frozenGroupOrderRef.current = [];
      if (sortField === field) setSortAsc((a) => !a);
      else {
        setSortField(field);
        setSortAsc(field === "name");
      }
    };

    const toggleGroup = useCallback((key: string) => {
      setExpandedGroups((prev) => ({
        ...prev,
        [key]: !prev[key],
      }));
    }, []);

    const quickKill = useCallback(
      async (e: React.MouseEvent, pid: number) => {
        e.stopPropagation();
        const res = await api.killProcess(pid);
        onActionFeedback(res);
      },
      [onActionFeedback]
    );

    const quickSuspend = useCallback(
      async (e: React.MouseEvent, proc: ProcessEntry) => {
        e.stopPropagation();
        const res = await api.setProcessSuspended(proc.pid, !proc.isSuspended);
        onActionFeedback(res);
      },
      [onActionFeedback]
    );

    const handleExportCsv = async () => {
      const tsTag = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      try {
        const path = await api.saveFile(
          `pulse-processes-${tsTag}.csv`,
          "CSV-Tabelle",
          ["csv"]
        );
        if (!path) return;

        const escapeCsv = (val: string) => `"${val.replace(/"/g, '""')}"`;
        const header =
          "pid,name,category,cpu_percent,gpu_percent,memory_mb,disk_read_kb_s,disk_write_kb_s,status,exe_path";
        const rows = filtered.map((p) =>
          [
            p.pid,
            escapeCsv(p.name),
            p.category,
            p.cpuPercent.toFixed(2),
            p.gpuPercent.toFixed(2),
            (p.memoryBytes / (1024 * 1024)).toFixed(2),
            (p.diskReadBytesPerSec / 1024).toFixed(1),
            (p.diskWriteBytesPerSec / 1024).toFixed(1),
            escapeCsv(p.status),
            escapeCsv(p.exePath),
          ].join(",")
        );
        await api.exportReport(path, [header, ...rows].join("\n"));
        onActionFeedback({
          ok: true,
          message: `${filtered.length} Prozesse als CSV exportiert.`,
        });
      } catch (err) {
        onActionFeedback({
          ok: false,
          message: `CSV-Export fehlgeschlagen: ${String(err)}`,
        });
      }
    };

    const runContextAction = async (fn: () => Promise<void>) => {
      setContextMenu(null);
      try {
        await fn();
      } catch (err) {
        onActionFeedback({ ok: false, message: String(err) });
      }
    };

    const renderSortIcon = (field: SortField) => {
      if (sortField !== field) return null;
      return sortAsc ? (
        <ArrowUp className="w-3 h-3 inline ml-1" />
      ) : (
        <ArrowDown className="w-3 h-3 inline ml-1" />
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
            <Search
              className="w-4 h-4 shrink-0"
              style={{ color: "var(--text-muted)" }}
            />
            <input
              ref={searchInputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Prozess, PID, Skript oder Pfad filtern… (Strg+F)"
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

          {/* Right Controls: Window Picker + CSV Export + Hover-Freeze + View Mode */}
          <div className="flex items-center gap-2">
            {onPickWindow && (
              <button
                onClick={onPickWindow}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium border cursor-pointer transition-colors hover:bg-[var(--bg-surface-hover)]"
                style={{
                  backgroundColor: pickingWindow
                    ? "var(--accent-cpu-soft)"
                    : "var(--bg-surface)",
                  borderColor: pickingWindow
                    ? "var(--accent-cpu)"
                    : "var(--border-subtle)",
                  color: pickingWindow
                    ? "var(--accent-cpu)"
                    : "var(--text-secondary)",
                }}
                title="Fenster-Picker: Klicke auf ein Fenster, um dessen Prozess zu inspizieren"
              >
                <Crosshair className="w-3.5 h-3.5" />
                <span className="hidden lg:inline">Picker</span>
              </button>
            )}

            <button
              onClick={handleExportCsv}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium border cursor-pointer transition-colors hover:bg-[var(--bg-surface-hover)]"
              style={{
                backgroundColor: "var(--bg-surface)",
                borderColor: "var(--border-subtle)",
                color: "var(--text-secondary)",
              }}
              title="Aktuelle Prozessliste als CSV exportieren"
            >
              <Download className="w-3.5 h-3.5" />
              <span className="hidden md:inline">CSV</span>
            </button>

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
            className={`grid ${GRID_COLS} items-center gap-2 px-3.5 py-2.5 border-b text-[11px] font-semibold uppercase tracking-wider shrink-0`}
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
              title="Aktuelle CPU-Auslastung + 30s-Verlauf"
            >
              CPU {renderSortIcon("cpu")}
            </button>
            <button
              onClick={() => toggleSort("gpu")}
              className="text-right cursor-pointer hover:text-[var(--text-primary)]"
            >
              GPU {renderSortIcon("gpu")}
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

          {/* Virtualized Table Body */}
          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto"
          >
            <div style={{ height: totalHeight, position: "relative" }}>
              <div
                style={{
                  transform: `translateY(${offsetY}px)`,
                  willChange: "transform",
                }}
              >
                {visibleRows.map((row) =>
                  row.kind === "group" ? (
                    <GroupRowItem
                      key={row.key}
                      group={row.group}
                      expanded={row.expanded}
                      totalMemoryBytes={totalMemoryBytes}
                      iconUri={getCachedProcessIcon(
                        row.group.items[0]?.exePath ?? ""
                      )}
                      onToggleGroup={toggleGroup}
                    />
                  ) : (
                    <ProcessRowItem
                      key={row.key}
                      proc={row.proc}
                      indentPx={row.indentPx}
                      totalMemoryBytes={totalMemoryBytes}
                      isSelected={selectedPid === row.proc.pid}
                      iconUri={getCachedProcessIcon(row.proc.exePath)}
                      onSelectPid={onSelectPid}
                      onContextMenu={handleRowContextMenu}
                      onQuickSuspend={quickSuspend}
                      onQuickKill={quickKill}
                    />
                  )
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right-click Context Menu */}
        {contextMenu && (
          <div
            ref={contextMenuRef}
            className="fixed z-50 w-54 rounded-xl border p-1.5 text-xs flex flex-col gap-0.5 select-none"
            style={{
              left: contextMenu.x,
              top: contextMenu.y,
              backgroundColor: "var(--bg-drawer)",
              borderColor: "var(--border-strong)",
              boxShadow: "var(--shadow-float)",
            }}
          >
            <div
              className="px-2.5 py-1.5 border-b mb-0.5 truncate font-semibold text-[11px]"
              style={{
                borderColor: "var(--border-subtle)",
                color: "var(--text-secondary)",
              }}
            >
              {contextMenu.proc.name}{" "}
              <span className="font-normal opacity-75">
                (PID {contextMenu.proc.pid})
              </span>
            </div>

            <button
              onClick={() => {
                const pid = contextMenu.proc.pid;
                setContextMenu(null);
                onSelectPid(pid);
              }}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-[var(--bg-surface-hover)] cursor-pointer text-left"
            >
              <Eye className="w-3.5 h-3.5" style={{ color: "var(--accent-cpu)" }} />
              <span>Inspizieren</span>
            </button>

            <button
              disabled={!contextMenu.proc.exePath}
              onClick={() => {
                const p = contextMenu.proc;
                runContextAction(async () => {
                  const newPid = await api.restartProcess(
                    p.pid,
                    p.exePath,
                    p.cmdLine
                  );
                  onActionFeedback({
                    ok: true,
                    message: `${p.name} neu gestartet (PID ${newPid}).`,
                  });
                  if (newPid > 0) onSelectPid(newPid);
                });
              }}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-[var(--bg-surface-hover)] cursor-pointer text-left disabled:opacity-40"
            >
              <RotateCw className="w-3.5 h-3.5" />
              <span>Neu starten</span>
            </button>

            <button
              onClick={() => {
                const p = contextMenu.proc;
                runContextAction(async () => {
                  const freed = await api.trimWorkingSet(p.pid);
                  onActionFeedback({
                    ok: true,
                    message:
                      freed > 0
                        ? `RAM von ${p.name} getrimmt (${formatBytes(freed)} freigegeben).`
                        : `RAM von ${p.name} getrimmt.`,
                  });
                });
              }}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-[var(--bg-surface-hover)] cursor-pointer text-left"
            >
              <Minimize2
                className="w-3.5 h-3.5"
                style={{ color: "var(--accent-ram)" }}
              />
              <span>RAM trimmen</span>
            </button>

            <button
              onClick={() => {
                const p = contextMenu.proc;
                runContextAction(async () => {
                  const res = await api.setProcessSuspended(p.pid, !p.isSuspended);
                  onActionFeedback(res);
                });
              }}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-[var(--bg-surface-hover)] cursor-pointer text-left"
            >
              {contextMenu.proc.isSuspended ? (
                <>
                  <Play className="w-3.5 h-3.5" style={{ color: "var(--accent-cpu)" }} />
                  <span>Fortsetzen</span>
                </>
              ) : (
                <>
                  <Pause className="w-3.5 h-3.5" style={{ color: "var(--accent-cpu)" }} />
                  <span>Pausieren (Einfrieren)</span>
                </>
              )}
            </button>

            <button
              onClick={() => {
                const p = contextMenu.proc;
                runContextAction(async () => {
                  const res = await api.setEfficiencyMode(
                    p.pid,
                    !p.isEfficiencyMode
                  );
                  onActionFeedback(res);
                });
              }}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-[var(--bg-surface-hover)] cursor-pointer text-left"
            >
              <Leaf className="w-3.5 h-3.5" style={{ color: "var(--accent-gpu)" }} />
              <span>
                {contextMenu.proc.isEfficiencyMode
                  ? "Eco-Modus deaktivieren"
                  : "Eco-Modus aktivieren"}
              </span>
            </button>

            <button
              disabled={!contextMenu.proc.exePath}
              onClick={() => {
                const exePath = contextMenu.proc.exePath;
                runContextAction(async () => {
                  const res = await api.openFileLocation(exePath);
                  onActionFeedback(res);
                });
              }}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-[var(--bg-surface-hover)] cursor-pointer text-left disabled:opacity-40"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span>Ordner öffnen</span>
            </button>

            <div
              className="my-0.5 border-t"
              style={{ borderColor: "var(--border-subtle)" }}
            />

            <button
              onClick={() => {
                const pid = contextMenu.proc.pid;
                runContextAction(async () => {
                  const res = await api.killProcess(pid);
                  onActionFeedback(res);
                });
              }}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-red-500/15 cursor-pointer text-left font-medium"
              style={{ color: "var(--accent-danger)" }}
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Prozess beenden</span>
            </button>

            <button
              onClick={() => {
                const pid = contextMenu.proc.pid;
                runContextAction(async () => {
                  const res = await api.killProcessTree(pid);
                  onActionFeedback(res);
                });
              }}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-red-500/15 cursor-pointer text-left font-medium"
              style={{ color: "var(--accent-danger)" }}
            >
              <Skull className="w-3.5 h-3.5" />
              <span>Prozessbaum beenden</span>
            </button>
          </div>
        )}
      </div>
    );
  }
);

ProcessesView.displayName = "ProcessesView";
