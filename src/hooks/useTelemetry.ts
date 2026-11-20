import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/tauri";
import { HistoryPoint, ProcessEntry, TelemetrySnapshot } from "../types/telemetry";

const MAX_CLIENT_HISTORY = 900;
const MAX_PROC_CPU_HISTORY = 30;
const MAX_EXITED_CACHE = 300;

function enrichProcessHistory(
  snap: TelemetrySnapshot,
  map: Map<number, number[]>,
  exitedCache: Map<number, ProcessEntry>,
  lastSeenByPid: Map<number, ProcessEntry>
): TelemetrySnapshot {
  if (snap.processes.length === 0) {
    return snap;
  }

  const activePids = new Set<number>();
  const enrichedProcesses: ProcessEntry[] = snap.processes.map((proc) => {
    activePids.add(proc.pid);
    let hist = map.get(proc.pid);
    if (!hist) {
      hist =
        proc.cpuHistory && proc.cpuHistory.length > 0
          ? proc.cpuHistory.slice(-MAX_PROC_CPU_HISTORY)
          : [proc.cpuPercent];
    } else {
      hist =
        hist.length >= MAX_PROC_CPU_HISTORY
          ? [...hist.slice(hist.length - MAX_PROC_CPU_HISTORY + 1), proc.cpuPercent]
          : [...hist, proc.cpuPercent];
    }
    map.set(proc.pid, hist);
    const enriched: ProcessEntry = { ...proc, cpuHistory: hist };
    // Remove from exitedCache if PID was reused
    if (exitedCache.has(proc.pid)) {
      exitedCache.delete(proc.pid);
    }
    return enriched;
  });

  // Archive terminated PIDs into bounded LRU exitedCache before pruning
  for (const [pid, prevEntry] of lastSeenByPid.entries()) {
    if (!activePids.has(pid)) {
      if (exitedCache.has(pid)) exitedCache.delete(pid);
      exitedCache.set(pid, prevEntry);
      if (exitedCache.size > MAX_EXITED_CACHE) {
        const oldestKey = exitedCache.keys().next().value;
        if (oldestKey !== undefined) exitedCache.delete(oldestKey);
      }
      lastSeenByPid.delete(pid);
    }
  }

  for (const p of enrichedProcesses) {
    lastSeenByPid.set(p.pid, p);
  }

  // Prune terminated PIDs from live sparkline map
  for (const pid of map.keys()) {
    if (!activePids.has(pid)) {
      map.delete(pid);
    }
  }

  return { ...snap, processes: enrichedProcesses };
}

function mergeHistoryPoints(
  existing: HistoryPoint[],
  incoming: HistoryPoint[]
): HistoryPoint[] {
  if (incoming.length === 0) return existing;
  const byTs = new Map<number, HistoryPoint>();
  for (const pt of existing) {
    byTs.set(pt.timestampMs, pt);
  }
  for (const pt of incoming) {
    byTs.set(pt.timestampMs, pt);
  }
  const merged = Array.from(byTs.values()).sort(
    (a, b) => a.timestampMs - b.timestampMs
  );
  return merged.length > MAX_CLIENT_HISTORY
    ? merged.slice(merged.length - MAX_CLIENT_HISTORY)
    : merged;
}

function appendHistoryPoint(
  prev: HistoryPoint[],
  point: HistoryPoint
): HistoryPoint[] {
  if (prev.length > 0) {
    const last = prev[prev.length - 1];
    if (last.timestampMs === point.timestampMs) {
      const copy = prev.slice();
      copy[copy.length - 1] = point;
      return copy;
    }
    if (point.timestampMs < last.timestampMs) {
      return prev;
    }
  }
  return prev.length >= MAX_CLIENT_HISTORY
    ? [...prev.slice(prev.length - MAX_CLIENT_HISTORY + 1), point]
    : [...prev, point];
}

export function useTelemetry() {
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  const cpuHistoryMapRef = useRef<Map<number, number[]>>(new Map());
  const exitedCacheRef = useRef<Map<number, ProcessEntry>>(new Map());
  const lastSeenByPidRef = useRef<Map<number, ProcessEntry>>(new Map());
  const pendingSnapshotRef = useRef<TelemetrySnapshot | null>(null);
  const pendingPointsRef = useRef<HistoryPoint[]>([]);

  const getExitedProcess = useCallback((pid: number): ProcessEntry | null => {
    return exitedCacheRef.current.get(pid) ?? null;
  }, []);

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | null = null;

    const flushPending = () => {
      if (!mounted) return;
      const pendingSnap = pendingSnapshotRef.current;
      const pendingPts = pendingPointsRef.current;
      if (pendingSnap) {
        pendingSnapshotRef.current = null;
        setSnapshot(pendingSnap);
        setIsConnected(true);
      }
      if (pendingPts.length > 0) {
        pendingPointsRef.current = [];
        setHistory((prev) => mergeHistoryPoints(prev, pendingPts));
      }
    };

    const onVisibilityChange = () => {
      if (!document.hidden) {
        flushPending();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    Promise.all([api.getSnapshot(), api.getHistory()])
      .then(([snap, hist]) => {
        if (!mounted) return;
        if (snap) {
          const enriched = enrichProcessHistory(
            snap,
            cpuHistoryMapRef.current,
            exitedCacheRef.current,
            lastSeenByPidRef.current
          );
          setSnapshot(enriched);
          setIsConnected(true);
        }
        if (hist && hist.length > 0) {
          setHistory((prev) => mergeHistoryPoints(hist, prev));
        }
      })
      .catch((err) => {
        console.error("Failed to fetch initial telemetry:", err);
      });

    api
      .subscribeTelemetry((rawSnap) => {
        if (!mounted) return;
        const snap = enrichProcessHistory(
          rawSnap,
          cpuHistoryMapRef.current,
          exitedCacheRef.current,
          lastSeenByPidRef.current
        );

        if (document.hidden) {
          pendingSnapshotRef.current = snap;
          const pts = pendingPointsRef.current;
          if (
            pts.length === 0 ||
            pts[pts.length - 1].timestampMs !== snap.latestPoint.timestampMs
          ) {
            pts.push(snap.latestPoint);
            if (pts.length > MAX_CLIENT_HISTORY) {
              pts.splice(0, pts.length - MAX_CLIENT_HISTORY);
            }
          }
          return;
        }

        setSnapshot(snap);
        setIsConnected(true);
        setHistory((prev) => appendHistoryPoint(prev, snap.latestPoint));
      })
      .then((fn) => {
        if (mounted) unlisten = fn;
        else fn();
      })
      .catch(console.error);

    return () => {
      mounted = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (unlisten) unlisten();
    };
  }, []);

  return { snapshot, history, isConnected, getExitedProcess };
}
