export type SplitRule = "firstDash" | "lastDash";

export type CleaningOptions = {
  stripPromoParens: boolean;
  underscoresToSpaces: boolean;
  collapseWhitespace: boolean;
  stripNoiseTokens: boolean;
  noiseExtendedMix: boolean;
  noiseVip: boolean;
  noiseRadioEdit: boolean;
  noiseBootleg: boolean;
  noiseMashup: boolean;
  noiseRemixEdit: boolean;
  normalizeFeat: boolean;
  splitRule: SplitRule;
  searchOnlyExtraStrip: boolean;
};

export type MatchingOptions = {
  limit: number;
  tagBias: string;
  fallbackRecordingOnly: boolean;
  fallbackStripParens: boolean;
  /** Send filename stem to Apple iTunes Search for artist/title/cover hints. */
  useItunesFilenameHints: boolean;
  useDeezer: boolean;
  useSpotify: boolean;
  useAmazon: boolean;
};

export type ApplyMetadataOptions = {
  writeTags: boolean;
  embedCover: boolean;
  genre: string | null;
  grouping: string | null;
  comment: string | null;
  tryItunesCoverFallback: boolean;
  embedPlaceholderWhenNoArt: boolean;
};

/** Separator between file name parts (maps to Rust `RenameOptions.separator`). */
export type RenameSeparator = "dashSpaced" | "dashTight" | "underscore" | "dot";

export type RenameSettings = {
  enabled: boolean;
  includeArtist: boolean;
  includeTitle: boolean;
  includeAlbum: boolean;
  includeYear: boolean;
  separator: RenameSeparator;
  partOrder: "artistFirst" | "titleFirst";
};

export type AppSettings = {
  cleaning: CleaningOptions;
  matching: MatchingOptions;
  applyMeta: ApplyMetadataOptions;
  autoLookupOnImport: boolean;
  rename: RenameSettings;
  spotifyClientId: string | null;
  spotifyClientSecret: string | null;
};

export type ProgressPayload = {
  kind: "scan" | "lookup" | "apply" | "rekordbox";
  done: number;
  total: number;
  message: string | null;
};
