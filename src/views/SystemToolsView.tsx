import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ArrowClockwise as RotateCw,
  ArrowsClockwise as RefreshCw,
  CheckCircle as CheckCircle2,
  FileLock as FileLock2,
  FolderLock as FolderSearch,
  FolderOpen,
  GearSix as Cog,
  MagnifyingGlass as Search,
  Play,
  Plus,
  RocketLaunch as Rocket,
  SlidersHorizontal,
  Stop as Square,
  Trash as Trash2,
  UploadSimple as Upload,
} from "@phosphor-icons/react";
import { api } from "../lib/tauri";
import {
  ActionResult,
  FileLockEntry,
  ProcessRule,
  ServiceEntry,
  StartupEntry,
} from "../types/telemetry";

interface SystemToolsViewProps {
  onInspectPid: (pid: number) => void;
  onActionFeedback: (res: ActionResult) => void;
  ruleDraftProcessName?: string | null;
  onClearRuleDraft?: () => void;
}

type ToolSubTab = "startup" | "services" | "filelock" | "rules";

export const SystemToolsView: React.FC<SystemToolsViewProps> = React.memo(
  ({
    onInspectPid,
    onActionFeedback,
    ruleDraftProcessName,
    onClearRuleDraft,
  }) => {
    const [subTab, setSubTab] = useState<ToolSubTab>("startup");
    const timersRef = useRef<Set<number>>(new Set());

    useEffect(() => {
      return () => {
        for (const id of timersRef.current) {
          window.clearTimeout(id);
        }
        timersRef.current.clear();
      };
    }, []);

    const scheduleTimer = useCallback((fn: () => void, ms: number) => {
      const id = window.setTimeout(() => {
        timersRef.current.delete(id);
        fn();
      }, ms);
      timersRef.current.add(id);
    }, []);

    // Startup state
    const [startupItems, setStartupItems] = useState<StartupEntry[]>([]);
    const [startupLoading, setStartupLoading] = useState(false);

    // Services state
    const [services, setServices] = useState<ServiceEntry[]>([]);
    const [servicesLoading, setServicesLoading] = useState(false);
    const [svcSearch, setSvcSearch] = useState("");
    const [svcFilter, setSvcFilter] = useState<"all" | "active" | "stopped">(
      "all"
    );

    // File Lock Finder state
    const [filePath, setFilePath] = useState("");
    const [lockResults, setLockResults] = useState<FileLockEntry[] | null>(null);
    const [lockLoading, setLockLoading] = useState(false);
    const [isDraggingFile, setIsDraggingFile] = useState(false);

    // Process Rules state
    const [rules, setRules] = useState<ProcessRule[]>([]);
    const [rulesLoading, setRulesLoading] = useState(false);
    const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
    const [ruleProcName, setRuleProcName] = useState("");
    const [rulePriority, setRulePriority] = useState<string>("");
    const [ruleEcoMode, setRuleEcoMode] = useState<string>("");
    const [ruleAlertCpu, setRuleAlertCpu] = useState<string>("");
    const [ruleAlertRam, setRuleAlertRam] = useState<string>("");

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

    const loadRules = useCallback(async () => {
      setRulesLoading(true);
      try {
        const list = await api.listProcessRules();
        setRules(list);
      } catch {
        setRules([]);
      } finally {
        setRulesLoading(false);
      }
    }, []);

    useEffect(() => {
      if (subTab === "startup") loadStartup();
      if (subTab === "services") loadServices();
      if (subTab === "rules") loadRules();
    }, [subTab, loadStartup, loadServices, loadRules]);

    // Pre-fill rule form when navigated from ProcessInspector
    useEffect(() => {
      if (!ruleDraftProcessName) return;
      setSubTab("rules");
      setEditingRuleId(null);
      setRuleProcName(ruleDraftProcessName);
      setRulePriority("");
      setRuleEcoMode("");
      setRuleAlertCpu("");
      setRuleAlertRam("");
      onClearRuleDraft?.();
    }, [ruleDraftProcessName, onClearRuleDraft]);

    const runFileLockCheck = useCallback(
      async (targetPath: string) => {
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
      },
      [onActionFeedback]
    );

    // Tauri native drag-and-drop for File Lock Finder tab
    useEffect(() => {
      if (subTab !== "filelock") return;
      let mounted = true;
      let unlisten: (() => void) | null = null;

      getCurrentWebview()
        .onDragDropEvent((event) => {
          if (!mounted) return;
          if (
            event.payload.type === "enter" ||
            event.payload.type === "over"
          ) {
            setIsDraggingFile(true);
          } else if (event.payload.type === "drop") {
            setIsDraggingFile(false);
            const first = event.payload.paths[0];
            if (first) {
              setFilePath(first);
              runFileLockCheck(first);
            }
          } else {
            setIsDraggingFile(false);
          }
        })
        .then((fn) => {
          if (mounted) unlisten = fn;
          else fn();
        })
        .catch(() => {});

      return () => {
        mounted = false;
        setIsDraggingFile(false);
        if (unlisten) unlisten();
      };
    }, [subTab, runFileLockCheck]);

    const handleToggleStartup = async (entry: StartupEntry) => {
      if (entry.location === "Task Scheduler") return;
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
      scheduleTimer(loadServices, 500);
    };

    const handleServiceStartType = async (
      name: string,
      startType: "auto" | "manual" | "disabled"
    ) => {
      try {
        await api.setServiceStartType(name, startType);
        const label =
          startType === "auto"
            ? "Automatisch"
            : startType === "manual"
              ? "Manuell"
              : "Deaktiviert";
        onActionFeedback({
          ok: true,
          message: `Starttyp von „${name}“ auf ${label} gesetzt.`,
        });
        loadServices();
      } catch (err) {
        onActionFeedback({
          ok: false,
          message: `Starttyp konnte nicht geändert werden: ${String(err)}`,
        });
      }
    };

    const handlePickAndCheckFile = async () => {
      const picked = await api.pickFile();
      if (picked) {
        setFilePath(picked);
        runFileLockCheck(picked);
      }
    };

    const handlePickAndCheckFolder = async () => {
      const picked = await api.pickFolder();
      if (picked) {
        setFilePath(picked);
        runFileLockCheck(picked);
      }
    };

    const resetRuleForm = () => {
      setEditingRuleId(null);
      setRuleProcName("");
      setRulePriority("");
      setRuleEcoMode("");
      setRuleAlertCpu("");
      setRuleAlertRam("");
    };

    const handleSaveRule = async (e: React.FormEvent) => {
      e.preventDefault();
      const procName = ruleProcName.trim();
      if (!procName) return;

      const parsedCpu = ruleAlertCpu.trim() ? Number(ruleAlertCpu) : null;
      const parsedRam = ruleAlertRam.trim() ? Number(ruleAlertRam) : null;

      const rule: ProcessRule = {
        id: editingRuleId ?? `rule-${Date.now()}`,
        processName: procName,
        enabled: true,
        priority: rulePriority || null,
        ecoMode:
          ruleEcoMode === "on"
            ? true
            : ruleEcoMode === "off"
              ? false
              : null,
        affinityMask: null,
        alertCpuPct:
          parsedCpu != null && Number.isFinite(parsedCpu) && parsedCpu > 0
            ? parsedCpu
            : null,
        alertRamMb:
          parsedRam != null && Number.isFinite(parsedRam) && parsedRam > 0
            ? parsedRam
            : null,
      };

      try {
        const updated = await api.saveProcessRule(rule);
        setRules(updated);
        resetRuleForm();
        onActionFeedback({
          ok: true,
          message: `Regel für „${procName}“ gespeichert.`,
        });
      } catch (err) {
        onActionFeedback({
          ok: false,
          message: `Regel konnte nicht gespeichert werden: ${String(err)}`,
        });
      }
    };

    const handleToggleRule = async (rule: ProcessRule) => {
      try {
        const updated = await api.saveProcessRule({
          ...rule,
          enabled: !rule.enabled,
        });
        setRules(updated);
      } catch (err) {
        onActionFeedback({ ok: false, message: String(err) });
      }
    };

    const handleDeleteRule = async (rule: ProcessRule) => {
      try {
        const updated = await api.deleteProcessRule(rule.id);
        setRules(updated);
        if (editingRuleId === rule.id) resetRuleForm();
        onActionFeedback({
          ok: true,
          message: `Regel für „${rule.processName}“ gelöscht.`,
        });
      } catch (err) {
        onActionFeedback({ ok: false, message: String(err) });
      }
    };

    const handleEditRule = (rule: ProcessRule) => {
      setEditingRuleId(rule.id);
      setRuleProcName(rule.processName);
      setRulePriority(rule.priority ?? "");
      setRuleEcoMode(
        rule.ecoMode === true ? "on" : rule.ecoMode === false ? "off" : ""
      );
      setRuleAlertCpu(
        rule.alertCpuPct != null ? String(rule.alertCpuPct) : ""
      );
      setRuleAlertRam(rule.alertRamMb != null ? String(rule.alertRamMb) : "");
    };

    const { activeServiceCount, stoppedServiceCount } = useMemo(() => {
      let active = 0;
      let stopped = 0;
      for (let i = 0; i < services.length; i++) {
        if (services[i].status === "Aktiv") active++;
        else if (services[i].status === "Gestoppt") stopped++;
      }
      return { activeServiceCount: active, stoppedServiceCount: stopped };
    }, [services]);

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
            className="flex items-center p-1 rounded-xl border gap-1 flex-wrap"
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
                {
                  id: "rules",
                  label: "Prozess-Regeln",
                  icon: <SlidersHorizontal className="w-3.5 h-3.5" />,
                  color: "var(--accent-ram)",
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
              onClick={
                subTab === "startup"
                  ? loadStartup
                  : subTab === "services"
                    ? loadServices
                    : loadRules
              }
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
              className="grid grid-cols-[minmax(180px,1fr)_minmax(220px,1.5fr)_130px_86px] items-center gap-3 px-4 py-2.5 border-b text-[11px] font-semibold uppercase tracking-wider shrink-0"
              style={{
                borderColor: "var(--border-subtle)",
                backgroundColor: "var(--bg-subtle)",
                color: "var(--text-muted)",
              }}
            >
              <span>Programm</span>
              <span>Startbefehl</span>
              <span>Bereich / Quelle</span>
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
                startupItems.map((item) => {
                  const isTaskScheduler = item.location === "Task Scheduler";
                  return (
                    <div
                      key={item.id}
                      className="grid grid-cols-[minmax(180px,1fr)_minmax(220px,1.5fr)_130px_86px] items-center gap-3 px-4 py-2.5 border-b text-xs hover:bg-[var(--bg-surface-hover)] transition-colors"
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
                      <div className="flex items-center gap-1 flex-wrap">
                        <span
                          className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                          style={{
                            backgroundColor: isTaskScheduler
                              ? "var(--accent-ram-soft)"
                              : item.scope === "Benutzer"
                                ? "var(--accent-cpu-soft)"
                                : "var(--accent-disk-soft)",
                            color: isTaskScheduler
                              ? "var(--accent-ram)"
                              : item.scope === "Benutzer"
                                ? "var(--accent-cpu)"
                                : "var(--accent-disk)",
                          }}
                        >
                          {isTaskScheduler ? "Aufgabenplanung" : item.scope}
                        </span>
                      </div>
                      <div className="flex justify-end">
                        <button
                          disabled={isTaskScheduler}
                          onClick={() => handleToggleStartup(item)}
                          className="w-10 h-5.5 rounded-full p-0.5 transition-colors flex items-center cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
                          style={{
                            backgroundColor: item.enabled
                              ? "var(--accent-gpu)"
                              : "var(--border-strong)",
                            justifyContent: item.enabled
                              ? "flex-end"
                              : "flex-start",
                          }}
                          title={
                            isTaskScheduler
                              ? "Aufgabenplanung-Einträge sind schreibgeschützt (über Windows-Aufgabenplanung verwalten)"
                              : item.enabled
                                ? "Deaktivieren"
                                : "Aktivieren"
                          }
                        >
                          <span className="w-4.5 h-4.5 rounded-full bg-white shadow-sm block" />
                        </button>
                      </div>
                    </div>
                  );
                })
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
                <Search
                  className="w-4 h-4 shrink-0"
                  style={{ color: "var(--text-muted)" }}
                />
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
                    { id: "active", label: `Aktiv (${activeServiceCount})` },
                    {
                      id: "stopped",
                      label: `Gestoppt (${stoppedServiceCount})`,
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
                className="grid grid-cols-[minmax(180px,1.4fr)_minmax(120px,1fr)_86px_80px_118px_90px] items-center gap-2.5 px-4 py-2.5 border-b text-[11px] font-semibold uppercase tracking-wider shrink-0"
                style={{
                  borderColor: "var(--border-subtle)",
                  backgroundColor: "var(--bg-subtle)",
                  color: "var(--text-muted)",
                }}
              >
                <span>Anzeigename</span>
                <span>Dienstname</span>
                <span>PID</span>
                <span>Status</span>
                <span>Starttyp</span>
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
                  filteredServices.slice(0, 250).map((svc) => {
                    const normalizedStartType =
                      svc.startType === "auto" ||
                      svc.startType === "manual" ||
                      svc.startType === "disabled"
                        ? svc.startType
                        : "";
                    return (
                      <div
                        key={svc.name}
                        className="group grid grid-cols-[minmax(180px,1.4fr)_minmax(120px,1fr)_86px_80px_118px_90px] items-center gap-2.5 px-4 py-2 border-b text-xs hover:bg-[var(--bg-surface-hover)] transition-colors"
                        style={{ borderColor: "var(--border-subtle)" }}
                      >
                        <div className="font-medium truncate">
                          {svc.displayName}
                        </div>
                        <div
                          className="font-mono text-[11px] truncate"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {svc.name}
                        </div>
                        <div>
                          {svc.pid != null && svc.pid > 0 ? (
                            <button
                              onClick={() => onInspectPid(svc.pid!)}
                              className="px-1.5 py-0.5 rounded-md text-[10px] font-mono font-semibold tabular-nums cursor-pointer hover:underline"
                              style={{
                                backgroundColor: "var(--accent-cpu-soft)",
                                color: "var(--accent-cpu)",
                              }}
                              title={`Prozess PID ${svc.pid} im Inspector öffnen`}
                            >
                              PID {svc.pid}
                            </button>
                          ) : (
                            <span
                              className="text-[11px]"
                              style={{ color: "var(--text-muted)" }}
                            >
                              –
                            </span>
                          )}
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
                        <div>
                          <select
                            value={normalizedStartType}
                            onChange={(e) => {
                              const val = e.target.value as
                                | "auto"
                                | "manual"
                                | "disabled";
                              if (val) handleServiceStartType(svc.name, val);
                            }}
                            aria-label={`Starttyp für ${svc.name}`}
                            className="w-full px-2 py-1 rounded-lg text-[11px] border outline-none cursor-pointer"
                            style={{
                              backgroundColor: "var(--bg-surface-solid)",
                              borderColor: "var(--border-subtle)",
                              color: "var(--text-secondary)",
                            }}
                          >
                            {!normalizedStartType && (
                              <option value="" disabled>
                                Starttyp…
                              </option>
                            )}
                            <option value="auto">Automatisch</option>
                            <option value="manual">Manuell</option>
                            <option value="disabled">Deaktiviert</option>
                          </select>
                        </div>
                        <div className="flex items-center justify-end gap-1 opacity-75 group-hover:opacity-100">
                          {svc.status !== "Aktiv" ? (
                            <button
                              onClick={() =>
                                handleControlService(svc.name, "start")
                              }
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
                                onClick={() =>
                                  handleControlService(svc.name, "stop")
                                }
                                className="p-1.5 rounded-lg hover:bg-red-500/15 text-red-500 cursor-pointer"
                                title="Dienst stoppen"
                              >
                                <Square className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: FILE LOCK FINDER v2 (File + Folder + Drag & Drop) */}
        {subTab === "filelock" && (
          <div className="fluent-card p-6 flex flex-col gap-5 max-w-3xl">
            <div className="flex items-start gap-3">
              <div
                className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 duotone-glass-badge"
                style={{
                  backgroundColor: "var(--accent-net-soft)",
                  color: "var(--accent-net)",
                }}
              >
                <FileLock2 className="w-5.5 h-5.5" />
              </div>
              <div>
                <h3 className="text-base font-semibold">
                  Wer blockiert diese Datei oder diesen Ordner?
                </h3>
                <p
                  className="text-xs mt-1"
                  style={{ color: "var(--text-secondary)" }}
                >
                  Wähle eine Datei bzw. einen Ordner aus oder ziehe das Objekt
                  einfach per Drag &amp; Drop hier hinein. Spektr ermittelt über
                  die native Windows Restart Manager API sofort blockierende
                  Prozesse.
                </p>
              </div>
            </div>

            {/* Drag & Drop Zone */}
            <div
              className="rounded-xl border-2 border-dashed px-4 py-3 text-xs flex items-center justify-center gap-2 transition-colors"
              style={{
                borderColor: isDraggingFile
                  ? "var(--accent-net)"
                  : "var(--border-strong)",
                backgroundColor: isDraggingFile
                  ? "var(--accent-net-soft)"
                  : "var(--bg-subtle)",
                color: isDraggingFile
                  ? "var(--accent-net)"
                  : "var(--text-muted)",
              }}
            >
              <Upload className="w-4 h-4 shrink-0" />
              <span>
                {isDraggingFile
                  ? "Hier loslassen, um Sperren sofort zu prüfen…"
                  : "Datei oder Ordner hierher ziehen (Drag & Drop)"}
              </span>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <input
                value={filePath}
                onChange={(e) => setFilePath(e.target.value)}
                onKeyDown={(e) =>
                  e.key === "Enter" && runFileLockCheck(filePath)
                }
                placeholder="C:\Pfad\zur\blockierten\datei.ext oder Ordner"
                className="flex-1 min-w-[220px] px-3.5 py-2.5 rounded-xl border text-xs font-mono outline-none"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-subtle)",
                  color: "var(--text-primary)",
                }}
              />
              <button
                onClick={handlePickAndCheckFile}
                className="px-3 py-2.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 cursor-pointer hover:bg-[var(--bg-surface-hover)]"
                style={{
                  backgroundColor: "var(--bg-surface-solid)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <FolderSearch className="w-4 h-4" />
                Datei wählen
              </button>
              <button
                onClick={handlePickAndCheckFolder}
                className="px-3 py-2.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 cursor-pointer hover:bg-[var(--bg-surface-hover)]"
                style={{
                  backgroundColor: "var(--bg-surface-solid)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <FolderOpen className="w-4 h-4" />
                Ordner wählen
              </button>
              <button
                onClick={() => runFileLockCheck(filePath)}
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
                      Kein Prozess sperrt diesen Pfad aktuell — er ist frei!
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
                              scheduleTimer(
                                () => runFileLockCheck(filePath),
                                400
                              );
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

        {/* TAB 4: PERSISTENT PROCESS RULES */}
        {subTab === "rules" && (
          <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4 flex-1 min-h-0">
            {/* Compact Create / Edit Form */}
            <form
              onSubmit={handleSaveRule}
              className="fluent-card p-4 flex flex-col gap-3 h-fit"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <Plus
                    className="w-4 h-4"
                    style={{ color: "var(--accent-ram)" }}
                  />
                  {editingRuleId ? "Regel bearbeiten" : "Neue Prozess-Regel"}
                </h3>
                {editingRuleId && (
                  <button
                    type="button"
                    onClick={resetRuleForm}
                    className="text-[11px] hover:underline cursor-pointer"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Abbrechen
                  </button>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <label
                  className="text-[11px] font-medium"
                  style={{ color: "var(--text-muted)" }}
                >
                  Prozessname (z. B. chrome.exe, node.exe)
                </label>
                <input
                  value={ruleProcName}
                  onChange={(e) => setRuleProcName(e.target.value)}
                  placeholder="prozess.exe"
                  required
                  className="px-3 py-2 rounded-xl border text-xs font-mono outline-none"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    borderColor: "var(--border-subtle)",
                    color: "var(--text-primary)",
                  }}
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <label
                    className="text-[11px] font-medium"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Priorität
                  </label>
                  <select
                    value={rulePriority}
                    onChange={(e) => setRulePriority(e.target.value)}
                    className="px-2.5 py-2 rounded-xl border text-xs outline-none cursor-pointer"
                    style={{
                      backgroundColor: "var(--bg-surface-solid)",
                      borderColor: "var(--border-subtle)",
                      color: "var(--text-primary)",
                    }}
                  >
                    <option value="">Unverändert</option>
                    <option value="idle">Niedrig (Idle)</option>
                    <option value="below_normal">Niedriger als Normal</option>
                    <option value="normal">Normal</option>
                    <option value="above_normal">Höher als Normal</option>
                    <option value="high">Hoch</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1">
                  <label
                    className="text-[11px] font-medium"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Eco-Modus
                  </label>
                  <select
                    value={ruleEcoMode}
                    onChange={(e) => setRuleEcoMode(e.target.value)}
                    className="px-2.5 py-2 rounded-xl border text-xs outline-none cursor-pointer"
                    style={{
                      backgroundColor: "var(--bg-surface-solid)",
                      borderColor: "var(--border-subtle)",
                      color: "var(--text-primary)",
                    }}
                  >
                    <option value="">Unverändert</option>
                    <option value="on">Aktivieren</option>
                    <option value="off">Deaktivieren</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <label
                    className="text-[11px] font-medium"
                    style={{ color: "var(--text-muted)" }}
                  >
                    CPU-Alarm ab (%)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={ruleAlertCpu}
                    onChange={(e) => setRuleAlertCpu(e.target.value)}
                    placeholder="z. B. 80"
                    className="px-3 py-2 rounded-xl border text-xs tabular-nums outline-none"
                    style={{
                      backgroundColor: "var(--bg-subtle)",
                      borderColor: "var(--border-subtle)",
                      color: "var(--text-primary)",
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label
                    className="text-[11px] font-medium"
                    style={{ color: "var(--text-muted)" }}
                  >
                    RAM-Alarm ab (MB)
                  </label>
                  <input
                    type="number"
                    min={16}
                    value={ruleAlertRam}
                    onChange={(e) => setRuleAlertRam(e.target.value)}
                    placeholder="z. B. 4096"
                    className="px-3 py-2 rounded-xl border text-xs tabular-nums outline-none"
                    style={{
                      backgroundColor: "var(--bg-subtle)",
                      borderColor: "var(--border-subtle)",
                      color: "var(--text-primary)",
                    }}
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={!ruleProcName.trim()}
                className="mt-1 py-2 rounded-xl text-xs font-semibold text-white cursor-pointer disabled:opacity-40"
                style={{ backgroundColor: "var(--accent-ram)" }}
              >
                {editingRuleId ? "Änderungen speichern" : "Regel speichern"}
              </button>
            </form>

            {/* Saved Rules List */}
            <div className="fluent-card flex flex-col overflow-hidden min-h-0">
              <div
                className="px-4 py-2.5 border-b text-[11px] font-semibold uppercase tracking-wider shrink-0 flex items-center justify-between"
                style={{
                  borderColor: "var(--border-subtle)",
                  backgroundColor: "var(--bg-subtle)",
                  color: "var(--text-muted)",
                }}
              >
                <span>Gespeicherte Regeln ({rules.length})</span>
                <span>Automatisch bei Prozessstart</span>
              </div>

              <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
                {rulesLoading ? (
                  <div
                    className="p-8 text-center text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Lade Prozess-Regeln…
                  </div>
                ) : rules.length === 0 ? (
                  <div
                    className="p-8 text-center text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Noch keine Regeln angelegt. Erstelle links eine Regel, um
                    Prioritäten, Eco-Modus oder Ressourcen-Alarme automatisch
                    anzuwenden.
                  </div>
                ) : (
                  rules.map((rule) => (
                    <div
                      key={rule.id}
                      className="p-3 rounded-xl border flex items-center justify-between gap-3"
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        borderColor: "var(--border-subtle)",
                        opacity: rule.enabled ? 1 : 0.6,
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold font-mono truncate">
                          {rule.processName}
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap mt-1">
                          {rule.priority && (
                            <span
                              className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                              style={{
                                backgroundColor: "var(--accent-cpu-soft)",
                                color: "var(--accent-cpu)",
                              }}
                            >
                              Prio: {rule.priority}
                            </span>
                          )}
                          {rule.ecoMode != null && (
                            <span
                              className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                              style={{
                                backgroundColor: "var(--accent-gpu-soft)",
                                color: "var(--accent-gpu)",
                              }}
                            >
                              Eco: {rule.ecoMode ? "Ein" : "Aus"}
                            </span>
                          )}
                          {rule.alertCpuPct != null && (
                            <span
                              className="text-[10px] font-semibold px-1.5 py-0.5 rounded tabular-nums"
                              style={{
                                backgroundColor: "var(--accent-disk-soft)",
                                color: "var(--accent-disk)",
                              }}
                            >
                              CPU &gt; {rule.alertCpuPct}%
                            </span>
                          )}
                          {rule.alertRamMb != null && (
                            <span
                              className="text-[10px] font-semibold px-1.5 py-0.5 rounded tabular-nums"
                              style={{
                                backgroundColor: "var(--accent-ram-soft)",
                                color: "var(--accent-ram)",
                              }}
                            >
                              RAM &gt; {rule.alertRamMb} MB
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => handleEditRule(rule)}
                          className="px-2 py-1 rounded-lg text-[11px] font-medium border cursor-pointer hover:bg-[var(--bg-surface-hover)]"
                          style={{ borderColor: "var(--border-subtle)" }}
                        >
                          Bearbeiten
                        </button>
                        <button
                          onClick={() => handleToggleRule(rule)}
                          className="w-9 h-5 rounded-full p-0.5 transition-colors cursor-pointer flex items-center"
                          style={{
                            backgroundColor: rule.enabled
                              ? "var(--accent-gpu)"
                              : "var(--border-strong)",
                            justifyContent: rule.enabled
                              ? "flex-end"
                              : "flex-start",
                          }}
                          title={rule.enabled ? "Deaktivieren" : "Aktivieren"}
                        >
                          <span className="w-4 h-4 rounded-full bg-white shadow-sm block" />
                        </button>
                        <button
                          onClick={() => handleDeleteRule(rule)}
                          className="p-1.5 rounded-lg hover:bg-red-500/15 text-red-500 cursor-pointer"
                          title="Regel löschen"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }
);

SystemToolsView.displayName = "SystemToolsView";
