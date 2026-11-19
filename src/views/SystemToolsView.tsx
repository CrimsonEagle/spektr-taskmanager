import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Cog,
  FileLock2,
  FolderSearch,
  Play,
  RefreshCw,
  Rocket,
  RotateCw,
  Search,
  Square,
  Trash2,
} from "lucide-react";
import { api } from "../lib/tauri";
import {
  ActionResult,
  FileLockEntry,
  ServiceEntry,
  StartupEntry,
} from "../types/telemetry";

interface SystemToolsViewProps {
  onInspectPid: (pid: number) => void;
  onActionFeedback: (res: ActionResult) => void;
}

type ToolSubTab = "startup" | "services" | "filelock";

export const SystemToolsView: React.FC<SystemToolsViewProps> = ({
  onInspectPid,
  onActionFeedback,
}) => {
  const [subTab, setSubTab] = useState<ToolSubTab>("startup");

  // Startup state
  const [startupItems, setStartupItems] = useState<StartupEntry[]>([]);
  const [startupLoading, setStartupLoading] = useState(false);

  // Services state
  const [services, setServices] = useState<ServiceEntry[]>([]);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [svcSearch, setSvcSearch] = useState("");
  const [svcFilter, setSvcFilter] = useState<"all" | "active" | "stopped">("all");

  // File Lock Finder state
  const [filePath, setFilePath] = useState("");
  const [lockResults, setLockResults] = useState<FileLockEntry[] | null>(null);
  const [lockLoading, setLockLoading] = useState(false);

  const loadStartup = useCallback(async () => {
    setStartupLoading(true);
    try {
      const items = await api.getStartupEntries();
      setStartupItems(items);
    } finally {
      setStartupLoading(false);
    }
  }, []);

  const loadServices = useCallback(async () => {
    setServicesLoading(true);
    try {
      const list = await api.getServices();
      setServices(list);
    } finally {
      setServicesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (subTab === "startup") loadStartup();
    if (subTab === "services") loadServices();
  }, [subTab, loadStartup, loadServices]);

  const handleToggleStartup = async (entry: StartupEntry) => {
    const res = await api.toggleStartupEntry(
      entry.name,
      entry.registrySubkey,
      !entry.enabled
    );
    onActionFeedback(res);
    if (res.ok) loadStartup();
  };

  const handleControlService = async (
    name: string,
    action: "start" | "stop" | "restart"
  ) => {
    const res = await api.controlService(name, action);
    onActionFeedback(res);
    setTimeout(loadServices, 500);
  };

  const handlePickAndCheckFile = async () => {
    const picked = await api.pickFile();
    if (picked) {
      setFilePath(picked);
      runFileLockCheck(picked);
    }
  };

  const runFileLockCheck = async (targetPath = filePath) => {
    if (!targetPath.trim()) return;
    setLockLoading(true);
    try {
      const results = await api.checkFileLocks(targetPath);
      setLockResults(results);
    } catch (err) {
      onActionFeedback({ ok: false, message: String(err) });
      setLockResults(null);
    } finally {
      setLockLoading(false);
    }
  };

  const filteredServices = useMemo(() => {
    const q = svcSearch.trim().toLowerCase();
    return services.filter((s) => {
      if (svcFilter === "active" && s.status !== "Aktiv") return false;
      if (svcFilter === "stopped" && s.status !== "Gestoppt") return false;
      if (!q) return true;
      return (
        s.displayName.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q)
      );
    });
  }, [services, svcSearch, svcFilter]);

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Sub-Navigation Pills */}
      <div className="flex items-center justify-between flex-wrap gap-2 shrink-0">
        <div
          className="flex items-center p-1 rounded-xl border gap-1"
          style={{
            backgroundColor: "var(--bg-surface)",
            borderColor: "var(--border-subtle)",
          }}
        >
          {(
            [
              {
                id: "startup",
                label: "Autostart",
                icon: <Rocket className="w-3.5 h-3.5" />,
                color: "var(--accent-disk)",
              },
              {
                id: "services",
                label: "Windows-Dienste",
                icon: <Cog className="w-3.5 h-3.5" />,
                color: "var(--accent-cpu)",
              },
              {
                id: "filelock",
                label: "File Lock Finder",
                icon: <FileLock2 className="w-3.5 h-3.5" />,
                color: "var(--accent-net)",
              },
            ] as const
          ).map((t) => {
            const active = subTab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setSubTab(t.id)}
                className="flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer"
                style={{
                  backgroundColor: active
                    ? "var(--bg-surface-active)"
                    : "transparent",
                  color: active ? t.color : "var(--text-secondary)",
                }}
              >
                {t.icon}
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>

        {subTab !== "filelock" && (
          <button
            onClick={subTab === "startup" ? loadStartup : loadServices}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-medium cursor-pointer hover:bg-[var(--bg-surface-hover)]"
            style={{
              backgroundColor: "var(--bg-surface)",
              borderColor: "var(--border-subtle)",
              color: "var(--text-secondary)",
            }}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Aktualisieren
          </button>
        )}
      </div>

      {/* TAB 1: STARTUP APPS */}
      {subTab === "startup" && (
        <div className="fluent-card flex-1 flex flex-col overflow-hidden">
          <div
            className="grid grid-cols-[minmax(180px,1fr)_minmax(220px,1.5fr)_110px_86px] items-center gap-3 px-4 py-2.5 border-b text-[11px] font-semibold uppercase tracking-wider shrink-0"
            style={{
              borderColor: "var(--border-subtle)",
              backgroundColor: "var(--bg-subtle)",
              color: "var(--text-muted)",
            }}
          >
            <span>Programm</span>
            <span>Startbefehl</span>
            <span>Bereich</span>
            <span className="text-right">Status</span>
          </div>

          <div className="flex-1 overflow-y-auto">
            {startupLoading ? (
              <div
                className="p-8 text-center text-xs"
                style={{ color: "var(--text-muted)" }}
              >
                Lese Windows-Autostart-Einträge…
              </div>
            ) : startupItems.length === 0 ? (
              <div
                className="p-8 text-center text-xs"
                style={{ color: "var(--text-muted)" }}
              >
                Keine Autostart-Einträge gefunden.
              </div>
            ) : (
              startupItems.map((item) => (
                <div
                  key={item.id}
                  className="grid grid-cols-[minmax(180px,1fr)_minmax(220px,1.5fr)_110px_86px] items-center gap-3 px-4 py-2.5 border-b text-xs hover:bg-[var(--bg-surface-hover)] transition-colors"
                  style={{ borderColor: "var(--border-subtle)" }}
                >
                  <div className="font-semibold truncate">{item.name}</div>
                  <div
                    className="font-mono text-[11px] truncate"
                    style={{ color: "var(--text-muted)" }}
                    title={item.command}
                  >
                    {item.command}
                  </div>
                  <div>
                    <span
                      className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                      style={{
                        backgroundColor:
                          item.scope === "Benutzer"
                            ? "var(--accent-cpu-soft)"
                            : "var(--accent-disk-soft)",
                        color:
                          item.scope === "Benutzer"
                            ? "var(--accent-cpu)"
                            : "var(--accent-disk)",
                      }}
                    >
                      {item.scope}
                    </span>
                  </div>
                  <div className="flex justify-end">
                    <button
                      onClick={() => handleToggleStartup(item)}
                      className="w-10 h-5.5 rounded-full p-0.5 transition-colors cursor-pointer flex items-center"
                      style={{
                        backgroundColor: item.enabled
                          ? "var(--accent-gpu)"
                          : "var(--border-strong)",
                        justifyContent: item.enabled ? "flex-end" : "flex-start",
                      }}
                      title={item.enabled ? "Deaktivieren" : "Aktivieren"}
                    >
                      <span className="w-4.5 h-4.5 rounded-full bg-white shadow-sm block" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* TAB 2: WINDOWS SERVICES */}
      {subTab === "services" && (
        <div className="flex flex-col flex-1 gap-3 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-xl border flex-1 min-w-[220px] max-w-md"
              style={{
                backgroundColor: "var(--bg-surface)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <Search className="w-4 h-4 shrink-0" style={{ color: "var(--text-muted)" }} />
              <input
                value={svcSearch}
                onChange={(e) => setSvcSearch(e.target.value)}
                placeholder="Windows-Dienst suchen…"
                className="bg-transparent outline-none text-xs flex-1"
                style={{ color: "var(--text-primary)" }}
              />
            </div>

            <div className="flex items-center gap-1.5">
              {(
                [
                  { id: "all", label: `Alle (${services.length})` },
                  {
                    id: "active",
                    label: `Aktiv (${services.filter((s) => s.status === "Aktiv").length})`,
                  },
                  {
                    id: "stopped",
                    label: `Gestoppt (${services.filter((s) => s.status === "Gestoppt").length})`,
                  },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  onClick={() => setSvcFilter(f.id)}
                  className="px-2.5 py-1 rounded-full text-xs font-medium border cursor-pointer"
                  style={{
                    backgroundColor:
                      svcFilter === f.id
                        ? "var(--accent-cpu-soft)"
                        : "var(--bg-surface)",
                    borderColor:
                      svcFilter === f.id
                        ? "var(--accent-cpu)"
                        : "var(--border-subtle)",
                    color:
                      svcFilter === f.id
                        ? "var(--accent-cpu)"
                        : "var(--text-secondary)",
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="fluent-card flex-1 flex flex-col overflow-hidden">
            <div
              className="grid grid-cols-[minmax(200px,1.4fr)_minmax(140px,1fr)_90px_110px] items-center gap-3 px-4 py-2.5 border-b text-[11px] font-semibold uppercase tracking-wider shrink-0"
              style={{
                borderColor: "var(--border-subtle)",
                backgroundColor: "var(--bg-subtle)",
                color: "var(--text-muted)",
              }}
            >
              <span>Anzeigename</span>
              <span>Dienstname</span>
              <span>Status</span>
              <span className="text-right">Steuerung</span>
            </div>

            <div className="flex-1 overflow-y-auto">
              {servicesLoading ? (
                <div
                  className="p-8 text-center text-xs"
                  style={{ color: "var(--text-muted)" }}
                >
                  Lade Windows-Dienste…
                </div>
              ) : (
                filteredServices.slice(0, 250).map((svc) => (
                  <div
                    key={svc.name}
                    className="group grid grid-cols-[minmax(200px,1.4fr)_minmax(140px,1fr)_90px_110px] items-center gap-3 px-4 py-2 border-b text-xs hover:bg-[var(--bg-surface-hover)] transition-colors"
                    style={{ borderColor: "var(--border-subtle)" }}
                  >
                    <div className="font-medium truncate">{svc.displayName}</div>
                    <div
                      className="font-mono text-[11px] truncate"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {svc.name}
                    </div>
                    <div>
                      <span
                        className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                        style={{
                          backgroundColor:
                            svc.status === "Aktiv"
                              ? "var(--accent-gpu-soft)"
                              : "var(--bg-subtle)",
                          color:
                            svc.status === "Aktiv"
                              ? "var(--accent-gpu)"
                              : "var(--text-muted)",
                        }}
                      >
                        {svc.status}
                      </span>
                    </div>
                    <div className="flex items-center justify-end gap-1 opacity-75 group-hover:opacity-100">
                      {svc.status !== "Aktiv" ? (
                        <button
                          onClick={() => handleControlService(svc.name, "start")}
                          className="p-1.5 rounded-lg hover:bg-emerald-500/15 text-emerald-500 cursor-pointer"
                          title="Dienst starten"
                        >
                          <Play className="w-3.5 h-3.5" />
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={() =>
                              handleControlService(svc.name, "restart")
                            }
                            className="p-1.5 rounded-lg hover:bg-sky-500/15 text-sky-500 cursor-pointer"
                            title="Dienst neu starten"
                          >
                            <RotateCw className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleControlService(svc.name, "stop")}
                            className="p-1.5 rounded-lg hover:bg-red-500/15 text-red-500 cursor-pointer"
                            title="Dienst stoppen"
                          >
                            <Square className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: FILE LOCK FINDER */}
      {subTab === "filelock" && (
        <div className="fluent-card p-6 flex flex-col gap-5 max-w-3xl">
          <div className="flex items-start gap-3">
            <div
              className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0"
              style={{
                backgroundColor: "var(--accent-net-soft)",
                color: "var(--accent-net)",
              }}
            >
              <FileLock2 className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold">
                Wer blockiert diese Datei?
              </h3>
              <p
                className="text-xs mt-1"
                style={{ color: "var(--text-secondary)" }}
              >
                Wähle eine Datei aus, die sich nicht löschen oder verschieben
                lässt. Pulse fragt über die native Windows Restart Manager API
                sofort ab, welcher Prozess ein Handle auf diese Datei hält.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runFileLockCheck()}
              placeholder="C:\Pfad\zur\blockierten\datei.ext"
              className="flex-1 px-3.5 py-2.5 rounded-xl border text-xs font-mono outline-none"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-subtle)",
                color: "var(--text-primary)",
              }}
            />
            <button
              onClick={handlePickAndCheckFile}
              className="px-3.5 py-2.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 cursor-pointer hover:bg-[var(--bg-surface-hover)]"
              style={{
                backgroundColor: "var(--bg-surface-solid)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <FolderSearch className="w-4 h-4" />
              Datei wählen
            </button>
            <button
              onClick={() => runFileLockCheck()}
              disabled={lockLoading || !filePath.trim()}
              className="px-4 py-2.5 rounded-xl text-xs font-semibold text-white cursor-pointer disabled:opacity-40"
              style={{ backgroundColor: "var(--accent-net)" }}
            >
              {lockLoading ? "Prüfe…" : "Prüfen"}
            </button>
          </div>

          {lockResults !== null && (
            <div className="flex flex-col gap-2">
              {lockResults.length === 0 ? (
                <div
                  className="p-4 rounded-xl border flex items-center gap-2.5 text-xs font-medium"
                  style={{
                    backgroundColor: "var(--accent-gpu-soft)",
                    borderColor: "var(--accent-gpu)",
                    color: "var(--accent-gpu)",
                  }}
                >
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>
                    Kein Prozess sperrt diese Datei aktuell — sie ist frei!
                  </span>
                </div>
              ) : (
                <>
                  <div
                    className="text-xs font-semibold"
                    style={{ color: "var(--accent-danger)" }}
                  >
                    {lockResults.length} blockierende(r) Prozess(e) gefunden:
                  </div>
                  {lockResults.map((lock) => (
                    <div
                      key={`${lock.pid}-${lock.appName}`}
                      className="p-3 rounded-xl border flex items-center justify-between gap-3"
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        borderColor: "var(--border-subtle)",
                      }}
                    >
                      <div>
                        <div className="text-sm font-semibold">
                          {lock.appName}{" "}
                          <span
                            className="text-xs font-normal tabular-nums"
                            style={{ color: "var(--text-muted)" }}
                          >
                            (PID {lock.pid})
                          </span>
                        </div>
                        <div
                          className="text-[11px]"
                          style={{ color: "var(--text-secondary)" }}
                        >
                          {lock.processName} • {lock.appType}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => onInspectPid(lock.pid)}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium border cursor-pointer hover:bg-[var(--bg-surface-hover)]"
                          style={{ borderColor: "var(--border-subtle)" }}
                        >
                          Details
                        </button>
                        <button
                          onClick={async () => {
                            const res = await api.killProcess(lock.pid);
                            onActionFeedback(res);
                            setTimeout(() => runFileLockCheck(), 400);
                          }}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 cursor-pointer"
                          style={{
                            backgroundColor: "var(--accent-danger-soft)",
                            color: "var(--accent-danger)",
                          }}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Freigeben (Kill)
                        </button>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
