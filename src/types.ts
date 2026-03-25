export type TagSnapshot = {
  artist: string | null;
  title: string | null;
  album: string | null;
  albumArtist: string | null;
  trackNumber: number | null;
  year: number | null;
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
  renameFile: boolean;
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
  score: number | null;
};

export type LookupResult = {
  path: string;
  candidates: LookupCandidate[];
};

export type ReviewTrack = ScannedTrack & {
  candidates: LookupCandidate[];
  candidateIndex: number;
  reviewStatus: "pending" | "accepted" | "skipped";
};

export type ProposedTags = {
  artist: string;
  title: string;
  album: string;
  albumArtist: string;
  trackNumber: string;
  year: string;
  coverUrl: string | null;
};

export type ApplyOutcome = {
  path: string;
  ok: boolean;
  error: string | null;
};
