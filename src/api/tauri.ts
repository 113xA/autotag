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
} from "../options/types";

export async function scanFolder(
  path: string,
  cleaning: CleaningOptions,
): Promise<ScannedTrack[]> {
  return invoke<ScannedTrack[]>("scan_folder", { path, cleaning });
}

export async function batchLookup(
  items: { path: string; artist: string; title: string }[],
  matching: MatchingOptions,
): Promise<LookupResult[]> {
  return invoke<LookupResult[]>("batch_lookup", { items, matching });
}

export async function applyBatch(
  payloads: ApplyPayload[],
  meta: ApplyMetadataOptions,
): Promise<ApplyOutcome[]> {
  return invoke<ApplyOutcome[]>("apply_batch", { payloads, meta });
}

export async function previewRename(
  path: string,
  artist: string,
  title: string,
): Promise<string> {
  return invoke<string>("preview_rename", { path, artist, title });
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
  };
}
