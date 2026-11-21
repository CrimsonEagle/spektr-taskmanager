import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api } from "../lib/tauri";
import { LanguagePreference, ResolvedLanguage } from "../types/telemetry";
import { de, TranslationKey } from "./de";
import { en } from "./en";

export type { TranslationKey };

const STORAGE_KEY = "spektr_lang_pref";
const DICTS: Record<ResolvedLanguage, Record<TranslationKey, string>> = {
  de,
  en,
};

let activeLanguage: ResolvedLanguage = "de";

export function getCurrentLanguage(): ResolvedLanguage {
  return activeLanguage;
}

function detectSystemLanguage(): ResolvedLanguage {
  if (typeof navigator === "undefined") return "en";
  const lang = (navigator.language || "en").toLowerCase();
  return lang.startsWith("de") ? "de" : "en";
}

function loadInitialPreference(): LanguagePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "system" || saved === "de" || saved === "en") {
      return saved;
    }
  } catch {
    // ignore storage errors
  }
  return "system";
}

export function translate(
  lang: ResolvedLanguage,
  key: TranslationKey,
  params?: Record<string, string | number>
): string {
  const template = DICTS[lang][key] ?? DICTS.de[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    params[k] !== undefined ? String(params[k]) : `{${k}}`
  );
}

export function localizeServiceStatus(
  status: string,
  lang: ResolvedLanguage = activeLanguage
): string {
  if (lang === "de") return status;
  switch (status) {
    case "Aktiv":
      return "Running";
    case "Gestoppt":
      return "Stopped";
    case "Pausiert":
      return "Paused";
    case "Startet...":
      return "Starting…";
    case "Stoppt...":
      return "Stopping…";
    case "Unbekannt":
      return "Unknown";
    default:
      return status;
  }
}

export function localizeStartupScope(
  scope: string,
  lang: ResolvedLanguage = activeLanguage
): string {
  if (lang === "de") return scope;
  switch (scope) {
    case "Benutzer":
      return "User";
    case "System (32-Bit)":
      return "System (32-bit)";
    case "Benutzer (Logon)":
      return "User (Logon)";
    case "System (Boot)":
      return "System (Boot)";
    default:
      return scope;
  }
}

export function localizeSignatureStatus(
  status: string,
  lang: ResolvedLanguage = activeLanguage
): string {
  if (lang === "de") return status;
  switch (status) {
    case "Gültig signiert":
      return "Valid signature";
    case "Nicht signiert":
      return "Unsigned";
    case "Zertifikat abgelaufen":
      return "Certificate expired";
    case "Signatur beschädigt":
      return "Corrupted signature";
    case "Nicht vertrauenswürdig":
      return "Untrusted";
    case "Nicht unterstützt":
      return "Not supported";
    default:
      return status;
  }
}

export function localizeSpikeReason(
  reason: string | null | undefined,
  lang: ResolvedLanguage = activeLanguage
): string {
  if (!reason) return "";
  if (lang === "de") return reason;
  return reason
    .replace(/^CPU-Spike \((\d+%)\) durch /, "CPU spike ($1) by ")
    .replace(
      /^CPU-Spike \((\d+%)\) — kurzlebige Prozesse \/ Kernel$/,
      "CPU spike ($1) — short-lived processes / kernel"
    )
    .replace(/^CPU-Spike \((\d+%)\)$/, "CPU spike ($1)")
    .replace(/^Hoher RAM \((\d+%)\) durch /, "High RAM ($1) by ")
    .replace(/^GPU-Spitze \((\d+%)\)$/, "GPU spike ($1)");
}

interface I18nContextValue {
  preference: LanguagePreference;
  language: ResolvedLanguage;
  setPreference: (pref: LanguagePreference) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue>({
  preference: "system",
  language: "de",
  setPreference: () => {},
  t: (key, params) => translate("de", key, params),
});

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [preference, setPreference] = useState<LanguagePreference>(
    loadInitialPreference
  );
  const [systemLang, setSystemLang] = useState<ResolvedLanguage>(
    detectSystemLanguage
  );

  useEffect(() => {
    const onLanguageChange = () => setSystemLang(detectSystemLanguage());
    window.addEventListener("languagechange", onLanguageChange);
    return () => window.removeEventListener("languagechange", onLanguageChange);
  }, []);

  const language: ResolvedLanguage =
    preference === "system" ? systemLang : preference;
  activeLanguage = language;

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // ignore storage errors
    }
    document.documentElement.lang = language;
    api.setLanguage(language).catch(() => {});
  }, [preference, language]);

  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) =>
      translate(language, key, params),
    [language]
  );

  const value = useMemo<I18nContextValue>(
    () => ({ preference, language, setPreference, t }),
    [preference, language, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export function useI18n() {
  return useContext(I18nContext);
}
