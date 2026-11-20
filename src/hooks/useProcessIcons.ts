import { useEffect, useState } from "react";
import { api } from "../lib/tauri";

const MAX_ICON_CACHE = 200;

// Module-global LRU cache (Map preserves insertion order; re-inserting refreshes recency)
const iconCache = new Map<string, string | null>();
const inflightPaths = new Set<string>();

function normalizeIconUri(raw: string): string {
  if (!raw) return "";
  if (raw.startsWith("data:")) return raw;
  return `data:image/png;base64,${raw}`;
}

function setCachedIcon(path: string, uri: string | null) {
  if (iconCache.has(path)) {
    iconCache.delete(path);
  }
  iconCache.set(path, uri);
  if (iconCache.size > MAX_ICON_CACHE) {
    const oldestKey = iconCache.keys().next().value;
    if (oldestKey !== undefined) {
      iconCache.delete(oldestKey);
    }
  }
}

export function getCachedProcessIcon(exePath: string): string | null | undefined {
  if (!exePath) return null;
  const val = iconCache.get(exePath);
  if (val !== undefined) {
    // Refresh LRU recency
    iconCache.delete(exePath);
    iconCache.set(exePath, val);
  }
  return val;
}

/**
 * Lazily fetches native Windows app icons ONLY for currently visible, uncached exePaths.
 */
export function useProcessIcons(exePaths: string[]): number {
  const [version, setVersion] = useState(0);

  // Build a stable key from only the missing paths to avoid unnecessary effect runs
  const missing: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < exePaths.length; i++) {
    const p = exePaths[i];
    if (!p || seen.has(p) || iconCache.has(p) || inflightPaths.has(p)) continue;
    seen.add(p);
    missing.push(p);
  }
  const missingKey = missing.join("\0");

  useEffect(() => {
    if (!missingKey) return;
    const batch = missingKey.split("\0").filter(Boolean);
    if (batch.length === 0) return;

    let active = true;
    for (const p of batch) inflightPaths.add(p);

    api
      .getProcessIcons(batch)
      .then((result) => {
        for (const p of batch) {
          inflightPaths.delete(p);
          const raw = result?.[p];
          setCachedIcon(p, raw ? normalizeIconUri(raw) : null);
        }
        if (active) setVersion((v) => v + 1);
      })
      .catch(() => {
        for (const p of batch) {
          inflightPaths.delete(p);
          setCachedIcon(p, null);
        }
      });

    return () => {
      active = false;
    };
  }, [missingKey]);

  return version;
}
