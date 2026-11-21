import React, { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Play, Terminal, X } from "@phosphor-icons/react";
import { useI18n } from "../i18n";
import { api } from "../lib/tauri";
import { ActionResult } from "../types/telemetry";

interface RunTaskModalProps {
  onClose: () => void;
  onActionFeedback: (res: ActionResult) => void;
}

const QUICK_COMMANDS = [
  "wt",
  "cmd",
  "powershell",
  "explorer",
  "regedit",
  "services.msc",
];

export const RunTaskModal: React.FC<RunTaskModalProps> = React.memo(
  ({ onClose, onActionFeedback }) => {
    const { t } = useI18n();
    const [command, setCommand] = useState("");
    const [running, setRunning] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      const tmr = window.setTimeout(() => inputRef.current?.focus(), 20);
      return () => window.clearTimeout(tmr);
    }, []);

    const handleSubmit = async (cmdToRun = command) => {
      const trimmed = cmdToRun.trim();
      if (!trimmed || running) return;
      setRunning(true);
      try {
        await api.runNewTask(trimmed);
        onActionFeedback({
          ok: true,
          message: t("runTask.started", { cmd: trimmed }),
        });
        onClose();
      } catch (err) {
        onActionFeedback({
          ok: false,
          message: t("runTask.failed", { err: String(err) }),
        });
      } finally {
        setRunning(false);
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      }
    };

    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.14 }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        className="fixed inset-0 z-50 flex items-start justify-center pt-28 px-4"
        style={{
          backgroundColor: "rgba(0, 0, 0, 0.42)",
          backdropFilter: "blur(6px)",
        }}
      >
        <motion.div
          initial={{ opacity: 0, y: -12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.97 }}
          transition={{ type: "spring", stiffness: 460, damping: 34 }}
          onKeyDown={handleKeyDown}
          className="w-full max-w-md rounded-2xl border overflow-hidden flex flex-col"
          style={{
            backgroundColor: "var(--bg-drawer)",
            borderColor: "var(--border-strong)",
            boxShadow: "var(--shadow-float)",
          }}
        >
          <div
            className="flex items-center justify-between px-4 py-3 border-b"
            style={{ borderColor: "var(--border-subtle)" }}
          >
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Terminal
                className="w-4 h-4"
                style={{ color: "var(--accent-cpu)" }}
              />
              <span>{t("runTask.title")}</span>
            </div>
            <button
              onClick={onClose}
              className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer hover:bg-[var(--bg-surface-hover)]"
              style={{ color: "var(--text-secondary)" }}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-4 flex flex-col gap-3">
            <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
              {t("runTask.desc")}
            </p>
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder={t("runTask.placeholder")}
                className="flex-1 px-3 py-2 rounded-xl border text-xs font-mono outline-none"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-subtle)",
                  color: "var(--text-primary)",
                }}
              />
              <button
                disabled={running || !command.trim()}
                onClick={() => handleSubmit()}
                className="px-3.5 py-2 rounded-xl text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer disabled:opacity-40 shrink-0"
                style={{ backgroundColor: "var(--accent-cpu)" }}
              >
                <Play className="w-3.5 h-3.5" />
                {running ? t("runTask.starting") : t("runTask.run")}
              </button>
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              <span
                className="text-[10px] font-medium"
                style={{ color: "var(--text-muted)" }}
              >
                {t("runTask.quickStart")}
              </span>
              {QUICK_COMMANDS.map((cmd) => (
                <button
                  key={cmd}
                  onClick={() => handleSubmit(cmd)}
                  className="px-2 py-0.5 rounded-md text-[11px] font-mono border cursor-pointer hover:bg-[var(--bg-surface-hover)]"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    borderColor: "var(--border-subtle)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {cmd}
                </button>
              ))}
            </div>
          </div>
        </motion.div>
      </motion.div>
    );
  }
);

RunTaskModal.displayName = "RunTaskModal";
