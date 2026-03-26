export type TagSnapshot = {
  artist: string | null;
  title: string | null;
  album: string | null;
  albumArtist: string | null;
  trackNumber: number | null;
  year: number | null;
  /** File already has embedded cover art (from scan). */
  hasEmbeddedCover?: boolean;
};

export type CleanedFilename = {
  display: string;
  searchArtist: string;
  searchTitle: string;
};

export type ScannedTrack = {
  path: string;
  /** Base name from disk (e.g. `track.mp3`). */
  fileName: string;
  filenameStem: string;
  cleaned: CleanedFilename;
  current: TagSnapshot;
};

export type ApplyPayload = {
  path: string;
  artist: string;
  title: string;
  album: string;
  albumArtist: string | null;
  trackNumber: number | null;
  year: number | null;
  coverUrl: string | null;
  releaseMbid: string | null;
  /** User chose to strip cover; do not reuse embedded art from file. */
  removeEmbeddedCover?: boolean;
};

export type LookupCandidate = {
  recordingMbid: string;
  releaseMbid: string;
  artist: string;
  title: string;
  album: string;
  albumArtist: string | null;
  trackNumber: number | null;
  year: number | null;
  coverUrl: string | null;
  coverOptions: {
    url: string;
    source: string;
    width: number | null;
    height: number | null;
    score: number | null;
  }[];
  score: number | null;
};

export type LookupResult = {
  path: string;
  candidates: LookupCandidate[];
  confidence: "high" | "medium" | "low";
  artistGuesses: string[];
};

export type ReviewTrack = ScannedTrack & {
  candidates: LookupCandidate[];
  candidateIndex: number;
  reviewStatus: "pending" | "accepted" | "skipped";
  confidence: "high" | "medium" | "low";
  artistGuesses: string[];
};

export type ProposedTags = {
  artist: string;
  title: string;
  album: string;
  albumArtist: string;
  trackNumber: string;
  year: string;
  coverUrl: string | null;
  releaseMbid: string | null;
  /** Set when user clicks "None (remove cover)" so apply strips embedded art. */
  explicitlyNoCover?: boolean;
};

export type ApplyOutcome = {
  path: string;
  ok: boolean;
  error: string | null;
};

export type CleanRenameRequestItem = {
  path: string;
  cleanedDisplay: string;
};

export type CleanRenameOutcome = {
  path: string;
  nextPath: string | null;
  ok: boolean;
  error: string | null;
};

export type RekordboxTagSnapshot = {
  path: string;
  matchKey: string;
  name: string | null;
  artist: string | null;
  album: string | null;
  grouping: string | null;
  genre: string | null;
  averageBpm: number | null;
  tonality: string | null;
  rating: number | null;
  comments: string | null;
  remixer: string | null;
  label: string | null;
  trackNumber: number | null;
  discNumber: number | null;
  year: number | null;
  playCount: number | null;
};

export type RekordboxPathMatch = {
  path: string;
  rekordbox: RekordboxTagSnapshot | null;
};

export type RekordboxMatchSummary = {
  rekordboxTracksInXml: number;
  scannedPaths: number;
  matchedCount: number;
  matches: RekordboxPathMatch[];
};

export type RekordboxApplyPayload = {
  path: string;
  name: string | null;
  artist: string | null;
  album: string | null;
  grouping: string | null;
  genre: string | null;
  averageBpm: number | null;
  tonality: string | null;
  rating: number | null;
  comments: string | null;
  remixer: string | null;
  label: string | null;
  trackNumber: number | null;
  discNumber: number | null;
  year: number | null;
  playCount: number | null;
};

export type RekordboxWriteOptions = {
  writeBpm: boolean;
  writeKey: boolean;
  writeRating: boolean;
  writePlayCounter: boolean;
  writeComment: boolean;
  appendPlayCountToComment: boolean;
  writeRemixer: boolean;
  writeLabel: boolean;
  writeGenre: boolean;
  writeGrouping: boolean;
  writeTrackNumber: boolean;
  writeDiscNumber: boolean;
  writeYear: boolean;
  writeArtistTitleAlbum: boolean;
};
