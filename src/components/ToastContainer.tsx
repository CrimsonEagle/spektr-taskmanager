import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { ToastMessage } from "../types/telemetry";

interface ToastContainerProps {
  toasts: ToastMessage[];
}

export const ToastContainer: React.FC<ToastContainerProps> = React.memo(({ toasts }) => {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none max-w-sm">
      <AnimatePresence>
        {toasts.map((t) => {
          const icon =
            t.kind === "success" ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
            ) : t.kind === "error" ? (
              <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
            ) : t.kind === "warning" ? (
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
            ) : (
              <Info className="w-4 h-4 text-sky-500 shrink-0" />
            );

          return (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 18, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.96 }}
              transition={{ duration: 0.18 }}
              className="pointer-events-auto flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl border text-xs font-medium"
              style={{
                backgroundColor: "var(--bg-drawer)",
                borderColor: "var(--border-strong)",
                boxShadow: "var(--shadow-float)",
                color: "var(--text-primary)",
              }}
            >
              {icon}
              <span>{t.text}</span>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
});

ToastContainer.displayName = "ToastContainer";
