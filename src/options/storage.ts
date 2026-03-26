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
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const parsed = JSON.parse(raw) as LegacySettings;
    const p = migrateLegacy(parsed);
    return {
      ...d,
      ...p,
      cleaning: { ...d.cleaning, ...p.cleaning },
      matching: { ...d.matching, ...p.matching },
      applyMeta: { ...d.applyMeta, ...p.applyMeta },
      rename: { ...d.rename, ...p.rename },
    };
  } catch {
    return d;
  }
}

export function saveSettings(s: AppSettings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
