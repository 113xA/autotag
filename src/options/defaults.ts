import type { AppSettings, RenameSettings } from "./types";

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
  useItunesFilenameHints: true,
  useDeezer: true,
  useSpotify: false,
  useAmazon: true,
  useYoutube: false,
  verboseLogs: false,
});

export const defaultApplyMeta = (): AppSettings["applyMeta"] => ({
  writeTags: true,
  embedCover: true,
  genre: null,
  grouping: null,
  comment: null,
  tryItunesCoverFallback: true,
  embedPlaceholderWhenNoArt: true,
});

export const defaultRename = (): RenameSettings => ({
  enabled: false,
  includeArtist: true,
  includeTitle: true,
  includeAlbum: false,
  includeYear: false,
  separator: "dashSpaced",
  partOrder: "artistFirst",
});

export const defaultAppSettings = (): AppSettings => ({
  cleaning: defaultCleaning(),
  matching: defaultMatching(),
  applyMeta: defaultApplyMeta(),
  autoLookupOnImport: true,
  autoApplyOnComplete: false,
  rename: defaultRename(),
  spotifyClientId: null,
  spotifyClientSecret: null,
});
