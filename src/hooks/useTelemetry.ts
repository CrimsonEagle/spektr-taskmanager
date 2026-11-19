import { useEffect, useState } from "react";
import { api } from "../lib/tauri";
import { HistoryPoint, TelemetrySnapshot } from "../types/telemetry";

const MAX_CLIENT_HISTORY = 900;

export function useTelemetry() {
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | null = null;

    Promise.all([api.getSnapshot(), api.getHistory()])
      .then(([snap, hist]) => {
        if (!mounted) return;
        if (snap) {
          setSnapshot(snap);
          setIsConnected(true);
        }
        if (hist && hist.length > 0) {
          setHistory(hist);
        }
      })
      .catch((err) => {
        console.error("Failed to fetch initial telemetry:", err);
      });

    api
      .subscribeTelemetry((snap) => {
        if (!mounted) return;
        setSnapshot(snap);
        setIsConnected(true);
        setHistory((prev) => {
          const next =
            prev.length >= MAX_CLIENT_HISTORY
              ? [...prev.slice(prev.length - MAX_CLIENT_HISTORY + 1), snap.latestPoint]
              : [...prev, snap.latestPoint];
          return next;
        });
      })
      .then((fn) => {
        if (mounted) unlisten = fn;
        else fn();
      })
      .catch(console.error);

    return () => {
      mounted = false;
      if (unlisten) unlisten();
    };
  }, []);

  return { snapshot, history, isConnected };
}
