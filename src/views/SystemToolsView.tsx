import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ArrowClockwise as RotateCw,
  ArrowsClockwise as RefreshCw,
  CheckCircle as CheckCircle2,
  ClipboardText,
  FileLock as FileLock2,
  FolderLock as FolderSearch,
  FolderOpen,
  GearSix as Cog,
  MagnifyingGlass as Search,
  Play,
  Plus,
  RocketLaunch as Rocket,
  Shield,
  SlidersHorizontal,
  Stop as Square,
  Trash as Trash2,
  UploadSimple as Upload,
} from "@phosphor-icons/react";
import {
  localizeServiceStatus,
  localizeStartupScope,
  useI18n,
} from "../i18n";
import { api } from "../lib/tauri";
import {
  ActionResult,
  FileLockEntry,
  ProcessRule,
  ServiceEntry,
  StartupEntry,
  ToolSubTab,
} from "../types/telemetry";

interface SystemToolsViewProps {
  activeSubTab: ToolSubTab;
  onSubTabChange: (tab: ToolSubTab) => void;
  isElevated?: boolean | null;
  onInspectPid: (pid: number) => void;
  onActionFeedback: (res: ActionResult) => void;
  ruleDraftProcessName?: string | null;
  onClearRuleDraft?: () => void;
}

export const SystemToolsView: React.FC<SystemToolsViewProps> = React.memo(
  ({
    activeSubTab,
    onSubTabChange,
    isElevated,
    onInspectPid,
    onActionFeedback,
    ruleDraftProcessName,
    onClearRuleDraft,
  }) => {
    const { t, language } = useI18n();
    const subTab = activeSubTab;
    const setSubTab = onSubTabChange;
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
    }, [ruleDraftProcessName, onClearRuleDraft, setSubTab]);

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
            ? t("tools.services.startType.auto")
            : startType === "manual"
              ? t("tools.services.startType.manual")
              : t("tools.services.startType.disabled");
        onActionFeedback({
          ok: true,
          message: t("tools.services.startTypeSaved", { name, label }),
        });
        loadServices();
      } catch (err) {
        onActionFeedback({
          ok: false,
          message: t("tools.services.startTypeError", { err: String(err) }),
        });
      }
    };

    const handlePickAndCheckFile = useCallback(async () => {
      const picked = await api.pickFile();
      if (picked) {
        setFilePath(picked);
        runFileLockCheck(picked);
      }
    }, [runFileLockCheck]);

    const handlePickAndCheckFolder = async () => {
      const picked = await api.pickFolder();
      if (picked) {
        setFilePath(picked);
        runFileLockCheck(picked);
      }
    };

    const handlePasteFromClipboard = useCallback(async () => {
      try {
        const path = await api.readClipboardFilePath();
        if (path) {
          setFilePath(path);
          runFileLockCheck(path);
        } else {
          onActionFeedback({
            ok: false,
            message: t("tools.filelock.clipboardEmpty"),
          });
        }
      } catch (err) {
        onActionFeedback({ ok: false, message: String(err) });
      }
    }, [runFileLockCheck, onActionFeedback, t]);

    // Global Ctrl+V shortcut on File Lock Finder tab (reads Explorer CF_HDROP or text path)
    useEffect(() => {
      if (subTab !== "filelock") return;
      const onKeyDown = (e: KeyboardEvent) => {
        if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "v") return;
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        handlePasteFromClipboard();
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, [subTab, handlePasteFromClipboard]);

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
          message: t("tools.rules.savedToast", { name: procName }),
        });
      } catch (err) {
        onActionFeedback({
          ok: false,
          message: t("tools.rules.saveError", { err: String(err) }),
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
          message: t("tools.rules.deletedToast", { name: rule.processName }),
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
                  label: t("tools.tab.startup"),
                  icon: <Rocket className="w-3.5 h-3.5" />,
                  color: "var(--accent-disk)",
                },
                {
                  id: "services",
                  label: t("tools.tab.services"),
                  icon: <Cog className="w-3.5 h-3.5" />,
                  color: "var(--accent-cpu)",
                },
                {
                  id: "filelock",
                  label: t("tools.tab.filelock"),
                  icon: <FileLock2 className="w-3.5 h-3.5" />,
                  color: "var(--accent-net)",
                },
                {
                  id: "rules",
                  label: t("tools.tab.rules"),
                  icon: <SlidersHorizontal className="w-3.5 h-3.5" />,
                  color: "var(--accent-ram)",
                },
              ] as const
            ).map((tabItem) => {
              const active = subTab === tabItem.id;
              return (
                <button
                  key={tabItem.id}
                  onClick={() => setSubTab(tabItem.id)}
                  className="relative flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
                  style={{
                    color: active ? tabItem.color : "var(--text-secondary)",
                  }}
                >
                  {active && (
                    <motion.div
                      layoutId="toolsSubTabPill"
                      transition={{ type: "spring", stiffness: 460, damping: 34 }}
                      className="absolute inset-0 rounded-lg"
                      style={{ backgroundColor: "var(--bg-surface-active)" }}
                    />
                  )}
                  <span className="relative z-10 flex items-center gap-2">
                    {tabItem.icon}
                    <span>{tabItem.label}</span>
                  </span>
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
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-medium cursor-pointer transition-[background-color,transform] duration-150 hover:bg-[var(--bg-surface-hover)] active:scale-95"
              style={{
                backgroundColor: "var(--bg-surface)",
                borderColor: "var(--border-subtle)",
                color: "var(--text-secondary)",
              }}
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${
                  (subTab === "startup" && startupLoading) ||
                  (subTab === "services" && servicesLoading) ||
                  (subTab === "rules" && rulesLoading)
                    ? "animate-spin"
                    : ""
                }`}
              />
              {t("tools.refresh")}
            </button>
          )}
        </div>

        <motion.div
          key={subTab}
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          className="flex-1 flex flex-col min-h-0"
        >

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
              <span>{t("tools.startup.col.program")}</span>
              <span>{t("tools.startup.col.command")}</span>
              <span>{t("tools.startup.col.scope")}</span>
              <span className="text-right">{t("tools.startup.col.status")}</span>
            </div>

            <div className="flex-1 overflow-y-auto">
              {startupLoading ? (
                <div
                  className="p-8 text-center text-xs"
                  style={{ color: "var(--text-muted)" }}
                >
                  {t("tools.startup.loading")}
                </div>
              ) : startupItems.length === 0 ? (
                <div
                  className="p-8 text-center text-xs"
                  style={{ color: "var(--text-muted)" }}
                >
                  {t("tools.startup.empty")}
                </div>
              ) : (
                startupItems.map((item) => {
                  const isTaskScheduler = item.location === "Task Scheduler";
                  return (
                    <div
                      key={item.id}
                      className="h-[44px] box-border grid grid-cols-[minmax(180px,1fr)_minmax(220px,1.5fr)_130px_86px] items-center gap-3 px-4 border-b text-xs hover:bg-[var(--bg-surface-hover)] transition-colors"
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
                      <div className="flex items-center gap-1 overflow-hidden">
                        <span
                          className="text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap truncate"
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
                          {isTaskScheduler
                            ? t("tools.startup.taskScheduler")
                            : localizeStartupScope(item.scope, language)}
                        </span>
                      </div>
                      <div className="flex justify-end">
                        <button
                          disabled={isTaskScheduler}
                          onClick={() => handleToggleStartup(item)}
                          className="w-10 h-5.5 rounded-full p-0.5 transition-colors duration-200 flex items-center cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
                          style={{
                            backgroundColor: item.enabled
                              ? "var(--accent-gpu)"
                              : "var(--border-strong)",
                          }}
                          title={
                            isTaskScheduler
                              ? t("tools.startup.taskSchedulerTooltip")
                              : item.enabled
                                ? t("tools.startup.disable")
                                : t("tools.startup.enable")
                          }
                        >
                          <span
                            className="w-4.5 h-4.5 rounded-full bg-white shadow-sm block transition-transform duration-200 ease-out"
                            style={{
                              transform: item.enabled
                                ? "translateX(18px)"
                                : "translateX(0px)",
                            }}
                          />
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
                  placeholder={t("tools.services.searchPlaceholder")}
                  className="bg-transparent outline-none text-xs flex-1"
                  style={{ color: "var(--text-primary)" }}
                />
              </div>

              <div className="flex items-center gap-1.5">
                {(
                  [
                    {
                      id: "all",
                      label: t("tools.services.filter.all", {
                        count: services.length,
                      }),
                    },
                    {
                      id: "active",
                      label: t("tools.services.filter.active", {
                        count: activeServiceCount,
                      }),
                    },
                    {
                      id: "stopped",
                      label: t("tools.services.filter.stopped", {
                        count: stoppedServiceCount,
                      }),
                    },
                  ] as const
                ).map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setSvcFilter(f.id)}
                    className="px-2.5 py-1 rounded-full text-xs font-medium border cursor-pointer tabular-nums"
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
                <span>{t("tools.services.col.displayName")}</span>
                <span>{t("tools.services.col.name")}</span>
                <span>PID</span>
                <span>{t("tools.services.col.status")}</span>
                <span>{t("tools.services.col.startType")}</span>
                <span className="text-right">{t("tools.services.col.controls")}</span>
              </div>

              <div className="flex-1 overflow-y-auto">
                {servicesLoading ? (
                  <div
                    className="p-8 text-center text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {t("tools.services.loading")}
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
                        className="group h-[44px] box-border grid grid-cols-[minmax(180px,1.4fr)_minmax(120px,1fr)_86px_80px_118px_90px] items-center gap-2.5 px-4 border-b text-xs hover:bg-[var(--bg-surface-hover)] transition-colors"
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
                              title={t("tools.services.inspectTooltip", {
                                pid: svc.pid,
                              })}
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
                            className="text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
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
                            {localizeServiceStatus(svc.status, language)}
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
                            aria-label={t("tools.services.startTypeAria", {
                              name: svc.name,
                            })}
                            className="w-full px-2 py-1 rounded-lg text-[11px] border outline-none cursor-pointer"
                            style={{
                              backgroundColor: "var(--bg-surface-solid)",
                              borderColor: "var(--border-subtle)",
                              color: "var(--text-secondary)",
                            }}
                          >
                            {!normalizedStartType && (
                              <option value="" disabled>
                                {t("tools.services.startTypePlaceholder")}
                              </option>
                            )}
                            <option value="auto">
                              {t("tools.services.startType.auto")}
                            </option>
                            <option value="manual">
                              {t("tools.services.startType.manual")}
                            </option>
                            <option value="disabled">
                              {t("tools.services.startType.disabled")}
                            </option>
                          </select>
                        </div>
                        <div className="flex items-center justify-end gap-1 opacity-75 group-hover:opacity-100">
                          {svc.status !== "Aktiv" ? (
                            <button
                              onClick={() =>
                                handleControlService(svc.name, "start")
                              }
                              className="p-1.5 rounded-lg hover:bg-emerald-500/15 text-emerald-500 cursor-pointer"
                              title={t("tools.services.start")}
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
                                title={t("tools.services.restart")}
                              >
                                <RotateCw className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() =>
                                  handleControlService(svc.name, "stop")
                                }
                                className="p-1.5 rounded-lg hover:bg-red-500/15 text-red-500 cursor-pointer"
                                title={t("tools.services.stop")}
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
                  {t("tools.filelock.title")}
                </h3>
                <p
                  className="text-xs mt-1"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {t("tools.filelock.desc")}
                </p>
              </div>
            </div>

            {/* Drag & Drop Zone (or clear UIPI notice when running elevated) */}
            {isElevated ? (
              <div
                className="rounded-xl border px-4 py-3 text-xs flex items-start gap-2.5"
                style={{
                  borderColor: "rgba(245, 158, 11, 0.35)",
                  backgroundColor: "rgba(245, 158, 11, 0.08)",
                }}
              >
                <Shield className="w-4 h-4 shrink-0 mt-0.5 text-amber-500" />
                <div className="min-w-0">
                  <div
                    className="font-semibold"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {t("tools.filelock.adminNoticeTitle")}
                  </div>
                  <div
                    className="text-[11px] mt-0.5"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {t("tools.filelock.adminNoticeDesc")}
                  </div>
                </div>
              </div>
            ) : (
              <div
                onClick={handlePickAndCheckFile}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handlePickAndCheckFile();
                  }
                }}
                className={`rounded-xl border-2 border-dashed px-4 py-5 text-xs flex items-center justify-center gap-2.5 transition-[background-color,border-color,color,transform] duration-150 cursor-pointer hover:bg-[var(--bg-surface-hover)] ${
                  isDraggingFile ? "scale-[1.01]" : ""
                }`}
                style={{
                  borderColor: isDraggingFile
                    ? "var(--accent-net)"
                    : "var(--border-strong)",
                  backgroundColor: isDraggingFile
                    ? "var(--accent-net-soft)"
                    : "var(--bg-subtle)",
                  color: isDraggingFile
                    ? "var(--accent-net)"
                    : "var(--text-secondary)",
                }}
              >
                <Upload
                  className="w-4 h-4 shrink-0"
                  style={{ color: "var(--accent-net)" }}
                />
                <span>
                  {isDraggingFile
                    ? t("tools.filelock.dropActive")
                    : t("tools.filelock.dropIdle")}
                </span>
              </div>
            )}

            <div className="flex items-center gap-2 flex-wrap">
              <input
                value={filePath}
                onChange={(e) => setFilePath(e.target.value)}
                onPaste={(e) => {
                  if (!e.clipboardData.getData("text")) {
                    e.preventDefault();
                    handlePasteFromClipboard();
                  }
                }}
                onKeyDown={(e) =>
                  e.key === "Enter" && runFileLockCheck(filePath)
                }
                placeholder={t("tools.filelock.placeholder")}
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
                {t("tools.filelock.pickFile")}
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
                {t("tools.filelock.pickFolder")}
              </button>
              <button
                type="button"
                onClick={handlePasteFromClipboard}
                disabled={lockLoading}
                title={t("tools.filelock.pasteClipboardTooltip")}
                className="px-3 py-2.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 cursor-pointer hover:bg-[var(--bg-surface-hover)] disabled:opacity-40"
                style={{
                  backgroundColor: "var(--bg-surface-solid)",
                  borderColor: "var(--border-subtle)",
                }}
              >
                <ClipboardText className="w-4 h-4" />
                {t("tools.filelock.pasteClipboard")}
              </button>
              <button
                onClick={() => runFileLockCheck(filePath)}
                disabled={lockLoading || !filePath.trim()}
                className="px-4 py-2.5 rounded-xl text-xs font-semibold text-white cursor-pointer disabled:opacity-40"
                style={{ backgroundColor: "var(--accent-net)" }}
              >
                {lockLoading
                  ? t("tools.filelock.checking")
                  : t("tools.filelock.check")}
              </button>
            </div>

            {lockResults !== null && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
                className="flex flex-col gap-2"
              >
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
                    <span>{t("tools.filelock.free")}</span>
                  </div>
                ) : (
                  <>
                    <div
                      className="text-xs font-semibold"
                      style={{ color: "var(--accent-danger)" }}
                    >
                      {t("tools.filelock.found", { count: lockResults.length })}
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
                            {t("tools.filelock.details")}
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
                            {t("tools.filelock.unlockKill")}
                          </button>
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </motion.div>
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
                  {editingRuleId
                    ? t("tools.rules.editTitle")
                    : t("tools.rules.newTitle")}
                </h3>
                {editingRuleId && (
                  <button
                    type="button"
                    onClick={resetRuleForm}
                    className="text-[11px] hover:underline cursor-pointer"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {t("tools.rules.cancel")}
                  </button>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <label
                  className="text-[11px] font-medium"
                  style={{ color: "var(--text-muted)" }}
                >
                  {t("tools.rules.procLabel")}
                </label>
                <input
                  value={ruleProcName}
                  onChange={(e) => setRuleProcName(e.target.value)}
                  placeholder={t("tools.rules.procPlaceholder")}
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
                    {t("tools.rules.priority")}
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
                    <option value="">{t("tools.rules.unchanged")}</option>
                    <option value="idle">{t("tools.rules.prio.idle")}</option>
                    <option value="below_normal">
                      {t("tools.rules.prio.belowNormal")}
                    </option>
                    <option value="normal">{t("tools.rules.prio.normal")}</option>
                    <option value="above_normal">
                      {t("tools.rules.prio.aboveNormal")}
                    </option>
                    <option value="high">{t("tools.rules.prio.high")}</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1">
                  <label
                    className="text-[11px] font-medium"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {t("tools.rules.ecoMode")}
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
                    <option value="">{t("tools.rules.unchanged")}</option>
                    <option value="on">{t("tools.rules.enable")}</option>
                    <option value="off">{t("tools.rules.disable")}</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <label
                    className="text-[11px] font-medium"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {t("tools.rules.cpuAlert")}
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={ruleAlertCpu}
                    onChange={(e) => setRuleAlertCpu(e.target.value)}
                    placeholder={t("tools.rules.cpuPlaceholder")}
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
                    {t("tools.rules.ramAlert")}
                  </label>
                  <input
                    type="number"
                    min={16}
                    value={ruleAlertRam}
                    onChange={(e) => setRuleAlertRam(e.target.value)}
                    placeholder={t("tools.rules.ramPlaceholder")}
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
                {editingRuleId
                  ? t("tools.rules.saveChanges")
                  : t("tools.rules.saveRule")}
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
                <span>
                  {t("tools.rules.savedHeader", { count: rules.length })}
                </span>
                <span>{t("tools.rules.autoApplyHeader")}</span>
              </div>

              <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
                {rulesLoading ? (
                  <div
                    className="p-8 text-center text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {t("tools.rules.loading")}
                  </div>
                ) : rules.length === 0 ? (
                  <div
                    className="p-8 text-center text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {t("tools.rules.empty")}
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
                              Eco:{" "}
                              {rule.ecoMode
                                ? t("tools.rules.ecoOn")
                                : t("tools.rules.ecoOff")}
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
                          {t("tools.rules.edit")}
                        </button>
                        <button
                          onClick={() => handleToggleRule(rule)}
                          className="w-9 h-5 rounded-full p-0.5 transition-colors duration-200 cursor-pointer flex items-center"
                          style={{
                            backgroundColor: rule.enabled
                              ? "var(--accent-gpu)"
                              : "var(--border-strong)",
                          }}
                          title={
                            rule.enabled
                              ? t("tools.rules.disable")
                              : t("tools.rules.enable")
                          }
                        >
                          <span
                            className="w-4 h-4 rounded-full bg-white shadow-sm block transition-transform duration-200 ease-out"
                            style={{
                              transform: rule.enabled
                                ? "translateX(16px)"
                                : "translateX(0px)",
                            }}
                          />
                        </button>
                        <button
                          onClick={() => handleDeleteRule(rule)}
                          className="p-1.5 rounded-lg hover:bg-red-500/15 text-red-500 cursor-pointer"
                          title={t("tools.rules.delete")}
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
        </motion.div>
      </div>
    );
  }
);

SystemToolsView.displayName = "SystemToolsView";
