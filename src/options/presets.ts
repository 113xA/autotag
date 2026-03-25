import type { AppSettings } from "./types";

/** One-click EDM scene presets (MusicBrainz tag bias + default genre). */
export const EDM_PRESETS: Record<
  string,
  { label: string; apply: (s: AppSettings) => AppSettings }
> = {
  technoClub: {
    label: "Techno / club",
    apply: (s) => ({
      ...s,
      matching: {
        ...s.matching,
        tagBias: "tag:techno OR tag:electronic OR tag:house",
        limit: 10,
      },
      applyMeta: {
        ...s.applyMeta,
        genre: s.applyMeta.genre ?? "Techno",
      },
    }),
  },
  hardTechno: {
    label: "Hard techno",
    apply: (s) => ({
      ...s,
      matching: {
        ...s.matching,
        tagBias: "tag:\"hard techno\" OR tag:techno OR tag:industrial",
        limit: 10,
      },
      applyMeta: {
        ...s.applyMeta,
        genre: s.applyMeta.genre ?? "Hard Techno",
      },
    }),
  },
  hardcore: {
    label: "Hardcore / uptempo",
    apply: (s) => ({
      ...s,
      matching: {
        ...s.matching,
        tagBias: "tag:hardcore OR tag:gabber OR tag:\"hard dance\" OR tag:uptempo",
        limit: 10,
      },
      applyMeta: {
        ...s.applyMeta,
        genre: s.applyMeta.genre ?? "Hardcore",
      },
    }),
  },
  rawstyle: {
    label: "Rawstyle / raw",
    apply: (s) => ({
      ...s,
      matching: {
        ...s.matching,
        tagBias: "tag:rawstyle OR tag:hardstyle OR tag:hardcore",
        limit: 10,
      },
      applyMeta: {
        ...s.applyMeta,
        genre: s.applyMeta.genre ?? "Rawstyle",
      },
    }),
  },
  neutral: {
    label: "Neutral (no tag bias)",
    apply: (s) => ({
      ...s,
      matching: { ...s.matching, tagBias: "" },
    }),
  },
};

export function applyPreset(
  presetId: string,
  current: AppSettings,
): AppSettings {
  const p = EDM_PRESETS[presetId];
  if (!p) return current;
  return p.apply({ ...current, cleaning: { ...current.cleaning } });
}

export const GENRE_SUGGESTIONS = [
  "",
  "Techno",
  "Hard Techno",
  "Hardcore",
  "Rawstyle",
  "Hardstyle",
  "Hard Dance",
  "EDM",
  "Industrial",
];
