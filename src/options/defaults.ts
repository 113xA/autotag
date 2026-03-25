import type { AppSettings } from "./types";

export const defaultCleaning = (): AppSettings["cleaning"] => ({
  stripPromoParens: true,
  underscoresToSpaces: true,
  collapseWhitespace: true,
  stripNoiseTokens: true,
  noiseExtendedMix: true,
  noiseVip: true,
  noiseRadioEdit: true,
  noiseBootleg: true,
  noiseMashup: true,
  noiseRemixEdit: true,
  normalizeFeat: true,
  splitRule: "firstDash",
  searchOnlyExtraStrip: true,
});

export const defaultMatching = (): AppSettings["matching"] => ({
  limit: 8,
  tagBias: "",
  fallbackRecordingOnly: true,
  fallbackStripParens: true,
});

export const defaultApplyMeta = (): AppSettings["applyMeta"] => ({
  writeTags: true,
  embedCover: true,
  genre: null,
  grouping: null,
  comment: null,
});

export const defaultAppSettings = (): AppSettings => ({
  cleaning: defaultCleaning(),
  matching: defaultMatching(),
  applyMeta: defaultApplyMeta(),
  autoLookupOnImport: true,
  renameOnApply: false,
});
