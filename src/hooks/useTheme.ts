import { useEffect, useState } from "react";
import { api } from "../lib/tauri";
import { ResolvedTheme, ThemePreference } from "../types/telemetry";

const STORAGE_KEY = "pulse_theme_pref";

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as ThemePreference | null;
    return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
  });

  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (e: MediaQueryListEvent) => {
      setSystemTheme(e.matches ? "dark" : "light");
    };
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, []);

  const resolved: ResolvedTheme = preference === "system" ? systemTheme : preference;

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, preference);
    document.documentElement.dataset.theme = resolved;
    api.window.setTheme(resolved).catch(() => {});
  }, [preference, resolved]);

  const cycleTheme = () => {
    setPreference((prev) => {
      if (prev === "system") return "light";
      if (prev === "light") return "dark";
      return "system";
    });
  };

  return { preference, resolved, setPreference, cycleTheme };
}
