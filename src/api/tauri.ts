import { invoke } from "@tauri-apps/api/core";
import type {
  ApplyOutcome,
  ApplyPayload,
  LookupResult,
  ProposedTags,
  ReviewTrack,
  ScannedTrack,
} from "../types";
import type {
  ApplyMetadataOptions,
  CleaningOptions,
  MatchingOptions,
  RenameSettings,
} from "../options/types";

export async function scanFolder(
  path: string,
  cleaning: CleaningOptions,
): Promise<ScannedTrack[]> {
  return invoke<ScannedTrack[]>("scan_folder", { path, cleaning });
}

export type LookupBatchItem = {
  path: string;
  artist: string;
  title: string;
  filenameStem: string;
};

export async function batchLookup(
  items: LookupBatchItem[],
  matching: MatchingOptions,
): Promise<LookupResult[]> {
  return invoke<LookupResult[]>("batch_lookup", { items, matching });
}

export async function applyBatch(
  payloads: ApplyPayload[],
  meta: ApplyMetadataOptions,
  rename: RenameSettings,
): Promise<ApplyOutcome[]> {
  return invoke<ApplyOutcome[]>("apply_batch", {
    req: { payloads, meta, rename },
  });
}

export async function previewRename(
  path: string,
  artist: string,
  title: string,
  album: string,
  year: number | null,
  rename: RenameSettings,
): Promise<string> {
  return invoke<string>("preview_rename", {
    path,
    artist,
    title,
    album,
    year,
    rename,
  });
}

export function proposedFromTrack(track: ReviewTrack): ProposedTags {
  const c = track.candidates[track.candidateIndex];
  if (c) {
    return {
      artist: c.artist,
      title: c.title,
      album: c.album,
      albumArtist: c.albumArtist ?? "",
      trackNumber:
        c.trackNumber != null ? String(c.trackNumber) : "",
      year: c.year != null ? String(c.year) : "",
      coverUrl: c.coverUrl,
      releaseMbid: c.releaseMbid?.trim() || null,
    };
  }
  return {
    artist: track.cleaned.searchArtist,
    title: track.cleaned.searchTitle,
    album: "",
    albumArtist: "",
    trackNumber: "",
    year: "",
    coverUrl: null,
    releaseMbid: null,
  };
}
