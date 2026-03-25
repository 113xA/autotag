import { defaultAppSettings } from "./defaults";
import type { AppSettings } from "./types";

const KEY = "library-autotag-settings-v1";

export function loadSettings(): AppSettings {
  const d = defaultAppSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const p = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...d,
      ...p,
      cleaning: { ...d.cleaning, ...p.cleaning },
      matching: { ...d.matching, ...p.matching },
      applyMeta: { ...d.applyMeta, ...p.applyMeta },
    };
  } catch {
    return d;
  }
}

export function saveSettings(s: AppSettings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
