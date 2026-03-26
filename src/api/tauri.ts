import { invoke } from "@tauri-apps/api/core";
import type {
  ApplyOutcome,
  ApplyPayload,
  CleanRenameOutcome,
  CleanRenameRequestItem,
  LookupResult,
  ProposedTags,
  RekordboxApplyPayload,
  RekordboxMatchSummary,
  RekordboxWriteOptions,
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

export async function cleanRenameBatch(
  items: CleanRenameRequestItem[],
): Promise<CleanRenameOutcome[]> {
  return invoke<CleanRenameOutcome[]>("clean_rename_batch", {
    req: { items },
  });
}

export async function matchRekordboxLibrary(
  xmlPath: string,
  paths: string[],
): Promise<RekordboxMatchSummary> {
  return invoke<RekordboxMatchSummary>("match_rekordbox_library", {
    xmlPath,
    paths,
  });
}

export async function applyRekordboxBatch(
  payloads: RekordboxApplyPayload[],
  options: RekordboxWriteOptions,
): Promise<ApplyOutcome[]> {
  return invoke<ApplyOutcome[]>("apply_rekordbox_batch", {
    req: { payloads, options },
  });
}

export async function spotifyAuth(
  clientId: string,
  clientSecret: string,
): Promise<{ ok: boolean; expiresIn: number }> {
  return invoke<{ ok: boolean; expiresIn: number }>("spotify_auth", {
    clientId,
    clientSecret,
  });
}

export async function spotifyAuthBrowser(
  clientId: string,
): Promise<{ ok: boolean; expiresIn: number }> {
  return invoke<{ ok: boolean; expiresIn: number }>("spotify_auth_browser", {
    clientId,
  });
}

export async function saveSessionSnapshot(snapshot: unknown): Promise<void> {
  return invoke<void>("save_session_snapshot", { snapshot });
}

export async function loadSessionSnapshot(): Promise<unknown | null> {
  return invoke<unknown | null>("load_session_snapshot");
}

export async function clearSessionSnapshot(): Promise<void> {
  return invoke<void>("clear_session_snapshot");
}

export async function musicbrainzLookupOne(
  item: LookupBatchItem,
  matching: MatchingOptions,
): Promise<LookupResult> {
  return invoke<LookupResult>("musicbrainz_lookup_one", { item, matching });
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
