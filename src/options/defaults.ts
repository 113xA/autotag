import type { AppSettings, RenameSettings } from "./types";

function defaultLookupConcurrency(): number {
  const hc = Number(globalThis.navigator?.hardwareConcurrency ?? 4);
  if (!Number.isFinite(hc) || hc <= 0) return 4;
  return Math.max(2, Math.min(16, Math.round(hc)));
}

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
  useDiscogs: false,
  discogsToken: null,
  useYoutube: false,
  verifyMusicbrainzAfterFilename: false,
  verifyFingerprintAfterFilename: false,
  verboseLogs: false,
  concurrency: defaultLookupConcurrency(),
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

export const defaultGraphics = (): AppSettings["graphics"] => ({
  animationsEnabled: true,
  animationIntensity: 70,
  backgroundEffects: true,
  uiDensity: "comfortable",
});

export const defaultAppSettings = (): AppSettings => ({
  cleaning: defaultCleaning(),
  matching: defaultMatching(),
  applyMeta: defaultApplyMeta(),
  graphics: defaultGraphics(),
  autoLookupOnImport: false,
  autoApplyOnComplete: false,
  autoAcceptHighConfidence: false,
  autoAcceptConfidenceThreshold: 90,
  rename: defaultRename(),
  spotifyClientId: null,
  spotifyClientSecret: null,
});
