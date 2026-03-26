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

/** Data URL for embedded front cover, or null if none / too large. */
export async function readEmbeddedCoverPreview(
  path: string,
): Promise<string | null> {
  const v = await invoke<string | null>("read_embedded_cover_preview", { path });
  return v;
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
  run_id: number,
): Promise<LookupResult[]> {
  return invoke<LookupResult[]>("batch_lookup", { items, matching, runId: run_id });
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
  const currentArtist = track.current.artist?.trim() || "";
  const currentTitle = track.current.title?.trim() || "";
  const currentAlbum = track.current.album?.trim() || "";
  const currentAlbumArtist = track.current.albumArtist?.trim() || "";
  const currentTrackNumber =
    track.current.trackNumber != null ? String(track.current.trackNumber) : "";
  const currentYear = track.current.year != null ? String(track.current.year) : "";

  const c = track.candidates[track.candidateIndex];
  if (c) {
    return {
      artist: c.artist?.trim() || currentArtist || track.cleaned.searchArtist,
      title: c.title?.trim() || currentTitle || track.cleaned.searchTitle,
      album: c.album?.trim() || currentAlbum,
      albumArtist: c.albumArtist?.trim() || currentAlbumArtist,
      trackNumber:
        c.trackNumber != null ? String(c.trackNumber) : currentTrackNumber,
      year: c.year != null ? String(c.year) : currentYear,
      coverUrl: c.coverUrl,
      releaseMbid: c.releaseMbid?.trim() || null,
      explicitlyNoCover: false,
    };
  }
  return {
    artist: currentArtist || track.cleaned.searchArtist,
    title: currentTitle || track.cleaned.searchTitle,
    album: currentAlbum,
    albumArtist: currentAlbumArtist,
    trackNumber: currentTrackNumber,
    year: currentYear,
    coverUrl: null,
    releaseMbid: null,
    explicitlyNoCover: false,
  };
}

export type LibraryIndexResult = {
  indexed: number;
};

export type LibraryImportResult = {
  rowsWithPath: number;
  portableRows: number;
};

export async function libraryIndexFolder(
  path: string,
  cleaning: CleaningOptions,
): Promise<LibraryIndexResult> {
  return invoke<LibraryIndexResult>("library_index_folder", { path, cleaning });
}

export async function libraryCatalogCount(): Promise<number> {
  return invoke<number>("library_catalog_count");
}

export async function libraryPortablePendingCount(): Promise<number> {
  return invoke<number>("library_portable_pending_count");
}

export async function libraryExportFile(
  filePath: string,
  includePaths: boolean,
  includeFileName: boolean,
): Promise<void> {
  return invoke<void>("library_export_file", {
    file_path: filePath,
    include_paths: includePaths,
    include_file_name: includeFileName,
  });
}

export async function libraryImportFile(
  filePath: string,
): Promise<LibraryImportResult> {
  return invoke<LibraryImportResult>("library_import_file", {
    file_path: filePath,
  });
}

export async function libraryClearCatalog(): Promise<void> {
  return invoke<void>("library_clear_catalog");
}
