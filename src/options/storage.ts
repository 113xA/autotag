import { defaultAppSettings, defaultRename } from "./defaults";
import type { AppSettings } from "./types";

const KEY = "library-autotag-settings-v1";

type LegacySettings = Partial<AppSettings> & { renameOnApply?: boolean };

function migrateLegacy(p: LegacySettings): Partial<AppSettings> {
  const { renameOnApply, ...rest } = p;
  const out: Partial<AppSettings> = { ...rest };
  if (p.rename == null && typeof renameOnApply === "boolean") {
    out.rename = { ...defaultRename(), enabled: renameOnApply };
  }
  return out;
}

export function loadSettings(): AppSettings {
  const d = defaultAppSettings();
  const clampConcurrency = (v: number | undefined): number => {
    if (!Number.isFinite(v)) return d.matching.concurrency;
    return Math.max(1, Math.min(16, Math.round(v as number)));
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const parsed = JSON.parse(raw) as LegacySettings;
    const p = migrateLegacy(parsed);
    const merged = {
      ...d,
      ...p,
      cleaning: { ...d.cleaning, ...p.cleaning },
      matching: { ...d.matching, ...p.matching },
      applyMeta: { ...d.applyMeta, ...p.applyMeta },
      rename: { ...d.rename, ...p.rename },
    };
    return {
      ...merged,
      matching: {
        ...merged.matching,
        concurrency: clampConcurrency(merged.matching.concurrency),
      },
    };
  } catch {
    return d;
  }
}

export function saveSettings(s: AppSettings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
