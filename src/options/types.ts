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
};

export type ApplyMetadataOptions = {
  writeTags: boolean;
  embedCover: boolean;
  genre: string | null;
  grouping: string | null;
  comment: string | null;
};

export type AppSettings = {
  cleaning: CleaningOptions;
  matching: MatchingOptions;
  applyMeta: ApplyMetadataOptions;
  autoLookupOnImport: boolean;
  renameOnApply: boolean;
};

export type ProgressPayload = {
  kind: "scan" | "lookup" | "apply" | "rekordbox";
  done: number;
  total: number;
  message: string | null;
};
