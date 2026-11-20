import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Globe,
  RefreshCw,
  Search,
  Trash2,
  Wifi,
  X,
} from "lucide-react";
import {
  formatBytes,
  formatSpeed,
  getCategoryMeta,
} from "../lib/format";
import { api } from "../lib/tauri";
import {
  ActionResult,
  NetworkConnectionEntry,
  TelemetrySnapshot,
} from "../types/telemetry";

interface NetworkViewProps {
  snapshot: TelemetrySnapshot;
  onInspectPid: (pid: number) => void;
  onActionFeedback: (res: ActionResult) => void;
}

const DEV_PORTS = new Set([
  80, 443, 1420, 3000, 3001, 4200, 5000, 5173, 5174, 5432, 6379, 8000, 8080,
  8443, 9000, 11434, 27017,
]);

function isResolvableRemoteIp(ip: string): boolean {
  if (!ip || ip === "*" || ip === "0.0.0.0" || ip === "::" || ip === "::1") {
    return false;
  }
  if (ip.startsWith("127.")) return false;
  return true;
}

export const NetworkView: React.FC<NetworkViewProps> = React.memo(({
  snapshot,
  onInspectPid,
  onActionFeedback,
}) => {
  const [connections, setConnections] = useState<NetworkConnectionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterMode, setFilterMode] = useState<"listening" | "all">("listening");
  const [search, setSearch] = useState("");
  const [dnsCache, setDnsCache] = useState<Record<string, string | null>>({});
  const [dnsLoading, setDnsLoading] = useState<Record<string, boolean>>({});
  const mountedRef = useRef(true);
  const killTimerRef = useRef<number | null>(null);

  const fetchConnections = useCallback(async () => {
    try {
      const list = await api.getNetworkConnections();
      if (mountedRef.current) {
        setConnections(list);
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  // Overlap-safe recursive polling that pauses while the window is hidden
  useEffect(() => {
    mountedRef.current = true;
    let pollTimer: number | null = null;

    const scheduleNext = () => {
      if (!mountedRef.current || document.hidden) return;
      pollTimer = window.setTimeout(runPoll, 3000);
    };

    const runPoll = async () => {
      if (!mountedRef.current || document.hidden) return;
      await fetchConnections();
      scheduleNext();
    };

    const onVisibilityChange = () => {
      if (pollTimer !== null) {
        window.clearTimeout(pollTimer);
        pollTimer = null;
      }
      if (!document.hidden && mountedRef.current) {
        runPoll();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    runPoll();

    return () => {
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      if (killTimerRef.current !== null) window.clearTimeout(killTimerRef.current);
    };
  }, [fetchConnections]);

  const listeningCount = useMemo(() => {
    let count = 0;
    for (let i = 0; i < connections.length; i++) {
      if (connections[i].state === "LISTENING") count++;
    }
    return count;
  }, [connections]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase().replace(/^:/, "");
    return connections.filter((c) => {
      if (filterMode === "listening" && c.state !== "LISTENING") return false;
      if (!q) return true;
      return (
        String(c.localPort).includes(q) ||
        String(c.remotePort).includes(q) ||
        c.processName.toLowerCase().includes(q) ||
        c.processSubtitle.toLowerCase().includes(q) ||
        c.localAddr.toLowerCase().includes(q) ||
        c.remoteAddr.toLowerCase().includes(q) ||
        String(c.pid).includes(q)
      );
    });
  }, [connections, filterMode, search]);

  const killPortOwner = async (e: React.MouseEvent, pid: number) => {
    e.stopPropagation();
    const res = await api.killProcess(pid);
    onActionFeedback(res);
    if (killTimerRef.current !== null) {
      window.clearTimeout(killTimerRef.current);
    }
    killTimerRef.current = window.setTimeout(() => {
      killTimerRef.current = null;
      fetchConnections();
    }, 300);
  };

  const handleCloseTcp = async (
    e: React.MouseEvent,
    c: NetworkConnectionEntry
  ) => {
    e.stopPropagation();
    try {
      await api.closeTcpConnection(
        c.localAddr,
        c.localPort,
        c.remoteAddr,
        c.remotePort
      );
      onActionFeedback({
        ok: true,
        message: `TCP-Verbindung zu ${c.remoteAddr}:${c.remotePort} getrennt.`,
      });
      if (killTimerRef.current !== null) {
        window.clearTimeout(killTimerRef.current);
      }
      killTimerRef.current = window.setTimeout(() => {
        killTimerRef.current = null;
        fetchConnections();
      }, 250);
    } catch (err) {
      onActionFeedback({
        ok: false,
        message: `Verbindung konnte nicht getrennt werden: ${String(err)}`,
      });
    }
  };

  const handleResolveDns = async (e: React.MouseEvent, ip: string) => {
    e.stopPropagation();
    if (!isResolvableRemoteIp(ip) || dnsLoading[ip]) return;
    setDnsLoading((prev) => ({ ...prev, [ip]: true }));
    try {
      const host = await api.resolveReverseDns(ip);
      if (mountedRef.current) {
        setDnsCache((prev) => ({ ...prev, [ip]: host }));
      }
    } catch {
      if (mountedRef.current) {
        setDnsCache((prev) => ({ ...prev, [ip]: null }));
      }
    } finally {
      if (mountedRef.current) {
        setDnsLoading((prev) => ({ ...prev, [ip]: false }));
      }
    }
  };

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Network Interfaces Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 shrink-0">
        {snapshot.network.interfaces.slice(0, 3).map((iface) => (
          <div key={iface.name} className="fluent-card p-3.5 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                  style={{
                    backgroundColor: "var(--accent-net-soft)",
                    color: "var(--accent-net)",
                  }}
                >
                  <Wifi className="w-3.5 h-3.5" />
                </span>
                <span className="text-xs font-semibold truncate">
                  {iface.name}
                </span>
              </div>
              <span
                className="text-[10px] font-mono shrink-0"
                style={{ color: "var(--text-muted)" }}
              >
                {iface.ipAddresses.find((ip) => ip.includes(".")) ??
                  iface.ipAddresses[0] ??
                  ""}
              </span>
            </div>

            <div className="flex items-center justify-between text-xs tabular-nums">
              <span
                className="flex items-center gap-1 font-semibold"
                style={{ color: "var(--accent-net)" }}
              >
                <ArrowDown className="w-3 h-3" />
                {formatSpeed(iface.rxBytesPerSec)}
              </span>
              <span
                className="flex items-center gap-1 font-semibold"
                style={{ color: "var(--accent-disk)" }}
              >
                <ArrowUp className="w-3 h-3" />
                {formatSpeed(iface.txBytesPerSec)}
              </span>
            </div>

            <div
              className="text-[10px] flex justify-between tabular-nums"
              style={{ color: "var(--text-muted)" }}
            >
              <span>Empfangen: {formatBytes(iface.totalRxBytes)}</span>
              <span>Gesendet: {formatBytes(iface.totalTxBytes)}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Ports & Connections Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 shrink-0">
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
            placeholder="Port (:3000, :5173), Prozess oder IP suchen…"
            className="bg-transparent outline-none text-xs flex-1"
            style={{ color: "var(--text-primary)" }}
          />
        </div>

        <div className="flex items-center gap-2">
          <div
            className="flex items-center p-1 rounded-xl border gap-0.5 text-xs"
            style={{
              backgroundColor: "var(--bg-surface)",
              borderColor: "var(--border-subtle)",
            }}
          >
            <button
              onClick={() => setFilterMode("listening")}
              className="px-3 py-1 rounded-lg font-medium cursor-pointer transition-colors"
              style={{
                backgroundColor:
                  filterMode === "listening"
                    ? "var(--accent-net-soft)"
                    : "transparent",
                color:
                  filterMode === "listening"
                    ? "var(--accent-net)"
                    : "var(--text-muted)",
              }}
            >
              Offene Ports ({listeningCount})
            </button>
            <button
              onClick={() => setFilterMode("all")}
              className="px-3 py-1 rounded-lg font-medium cursor-pointer transition-colors"
              style={{
                backgroundColor:
                  filterMode === "all" ? "var(--bg-surface-active)" : "transparent",
                color:
                  filterMode === "all"
                    ? "var(--text-primary)"
                    : "var(--text-muted)",
              }}
            >
              Alle ({connections.length})
            </button>
          </div>

          <button
            onClick={fetchConnections}
            className="p-2 rounded-xl border cursor-pointer hover:bg-[var(--bg-surface-hover)]"
            style={{
              backgroundColor: "var(--bg-surface)",
              borderColor: "var(--border-subtle)",
              color: "var(--text-secondary)",
            }}
            title="Aktualisieren"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Ports Table */}
      <div className="fluent-card flex-1 flex flex-col overflow-hidden">
        <div
          className="grid grid-cols-[90px_76px_minmax(170px,1fr)_minmax(180px,1.1fr)_96px_118px] items-center gap-2 px-4 py-2.5 border-b text-[11px] font-semibold uppercase tracking-wider shrink-0"
          style={{
            borderColor: "var(--border-subtle)",
            backgroundColor: "var(--bg-subtle)",
            color: "var(--text-muted)",
          }}
        >
          <span>Port</span>
          <span>Protokoll</span>
          <span>Prozess</span>
          <span>Adresse</span>
          <span>Status</span>
          <span className="text-right">Aktion</span>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div
              className="p-8 text-center text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              Lade Netzwerk-Ports…
            </div>
          ) : filtered.length === 0 ? (
            <div
              className="p-8 text-center text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              Keine passenden Ports oder Verbindungen gefunden.
            </div>
          ) : (
            filtered.slice(0, 250).map((c, idx) => {
              const isDevPort = DEV_PORTS.has(c.localPort);
              const cat = getCategoryMeta(c.category);
              return (
                <div
                  key={`${c.protocol}-${c.localPort}-${c.remotePort}-${c.pid}-${idx}`}
                  onClick={() => c.pid > 4 && onInspectPid(c.pid)}
                  className="group grid grid-cols-[90px_76px_minmax(170px,1fr)_minmax(180px,1.1fr)_96px_118px] items-center gap-2 px-4 py-2 border-b text-xs transition-colors hover:bg-[var(--bg-surface-hover)] cursor-pointer"
                  style={{ borderColor: "var(--border-subtle)" }}
                >
                  <div className="font-mono font-bold tabular-nums flex items-center gap-1.5">
                    <span
                      className="px-2 py-0.5 rounded-md"
                      style={{
                        backgroundColor: isDevPort
                          ? "var(--accent-ram-soft)"
                          : "var(--bg-subtle)",
                        color: isDevPort
                          ? "var(--accent-ram)"
                          : "var(--text-primary)",
                      }}
                    >
                      :{c.localPort}
                    </span>
                  </div>

                  <span
                    className="text-[11px] font-medium"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {c.protocol}
                  </span>

                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: cat.color }}
                    />
                    <div className="min-w-0">
                      <div className="font-semibold truncate">
                        {c.processName}{" "}
                        <span
                          className="text-[10px] font-normal tabular-nums"
                          style={{ color: "var(--text-muted)" }}
                        >
                          ({c.pid})
                        </span>
                      </div>
                      {c.processSubtitle && (
                        <div
                          className="text-[10px] truncate"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {c.processSubtitle}
                        </div>
                      )}
                    </div>
                  </div>

                  <div
                    className="min-w-0 flex flex-col"
                    title={`${c.localAddr}:${c.localPort} -> ${c.remoteAddr}:${c.remotePort}`}
                  >
                    {c.state === "LISTENING" ? (
                      <span
                        className="font-mono text-[11px] truncate tabular-nums"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {c.localAddr}
                      </span>
                    ) : (
                      <>
                        <div className="flex items-center gap-1 min-w-0">
                          <span
                            className="font-mono text-[11px] truncate tabular-nums"
                            style={{ color: "var(--text-secondary)" }}
                          >
                            {c.remoteAddr}:{c.remotePort}
                          </span>
                          {isResolvableRemoteIp(c.remoteAddr) &&
                            !(c.remoteAddr in dnsCache) && (
                              <button
                                onClick={(e) => handleResolveDns(e, c.remoteAddr)}
                                disabled={!!dnsLoading[c.remoteAddr]}
                                className="px-1 py-0.5 rounded text-[9px] font-semibold inline-flex items-center gap-0.5 cursor-pointer hover:bg-[var(--bg-surface-active)] shrink-0"
                                style={{
                                  backgroundColor: "var(--bg-subtle)",
                                  color: "var(--accent-cpu)",
                                }}
                                title="Reverse-DNS (Hostname) auflösen"
                              >
                                <Globe className="w-2.5 h-2.5" />
                                {dnsLoading[c.remoteAddr] ? "…" : "DNS"}
                              </button>
                            )}
                        </div>
                        {c.remoteAddr in dnsCache && (
                          <span
                            className="text-[10px] truncate"
                            style={{ color: "var(--accent-cpu)" }}
                            title={dnsCache[c.remoteAddr] ?? "Kein Hostname"}
                          >
                            {dnsCache[c.remoteAddr] ?? "Kein PTR-Eintrag"}
                          </span>
                        )}
                      </>
                    )}
                  </div>

                  <div>
                    <span
                      className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                      style={{
                        backgroundColor:
                          c.state === "LISTENING"
                            ? "var(--accent-gpu-soft)"
                            : c.state === "ESTABLISHED"
                              ? "var(--accent-cpu-soft)"
                              : "var(--bg-subtle)",
                        color:
                          c.state === "LISTENING"
                            ? "var(--accent-gpu)"
                            : c.state === "ESTABLISHED"
                              ? "var(--accent-cpu)"
                              : "var(--text-muted)",
                      }}
                    >
                      {c.state}
                    </span>
                  </div>

                  <div className="flex justify-end items-center gap-1">
                    {c.protocol.toUpperCase().startsWith("TCP") &&
                      c.state === "ESTABLISHED" &&
                      c.localAddr.includes(".") &&
                      c.remoteAddr.includes(".") && (
                        <button
                          onClick={(e) => handleCloseTcp(e, c)}
                          className="opacity-0 group-hover:opacity-100 px-1.5 py-1 rounded-lg text-[10px] font-semibold flex items-center gap-0.5 cursor-pointer transition-opacity"
                          style={{
                            backgroundColor: "var(--accent-disk-soft)",
                            color: "var(--accent-disk)",
                          }}
                          title="TCP-Verbindung trennen (erfordert ggf. Adminrechte)"
                        >
                          <X className="w-3 h-3" />
                          Trennen
                        </button>
                      )}
                    {c.pid > 4 && (
                      <button
                        onClick={(e) => killPortOwner(e, c.pid)}
                        className="opacity-0 group-hover:opacity-100 px-2 py-1 rounded-lg text-[11px] font-semibold flex items-center gap-1 cursor-pointer transition-opacity"
                        style={{
                          backgroundColor: "var(--accent-danger-soft)",
                          color: "var(--accent-danger)",
                        }}
                        title={`Prozess ${c.processName} (PID ${c.pid}) beenden`}
                      >
                        <Trash2 className="w-3 h-3" />
                        Kill
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
});

NetworkView.displayName = "NetworkView";
