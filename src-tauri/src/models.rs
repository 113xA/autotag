use serde::{Deserialize, Serialize};

use crate::options::{ApplyMetadataOptions, RenameOptions};

pub const AUDIO_EXT: &[&str] = &[
    "mp3", "flac", "m4a", "mp4", "ogg", "opus",
    "wav", "aiff", "aif", "ape", "wv", "mpc", "aac",
];

/// Fields to write from Rekordbox into audio tags (checkboxes from settings).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RekordboxWriteOptions {
    pub write_bpm: bool,
    pub write_key: bool,
    /// Rekordbox star rating → ID3 POPM (replaces existing POPM frames when enabled).
    pub write_rating: bool,
    /// POPM play counter + optional comment line.
    pub write_play_counter: bool,
    pub write_comment: bool,
    pub append_play_count_to_comment: bool,
    pub write_remixer: bool,
    pub write_label: bool,
    pub write_genre: bool,
    pub write_grouping: bool,
    pub write_track_number: bool,
    pub write_disc_number: bool,
    pub write_year: bool,
    /// When set, overwrites artist / title / album from Rekordbox (`Artist`, `Name`, `Album`).
    pub write_artist_title_album: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RekordboxApplyPayload {
    pub path: String,
    pub name: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub grouping: Option<String>,
    pub genre: Option<String>,
    pub average_bpm: Option<f64>,
    pub tonality: Option<String>,
    pub rating: Option<u32>,
    pub comments: Option<String>,
    pub remixer: Option<String>,
    pub label: Option<String>,
    pub track_number: Option<u32>,
    pub disc_number: Option<u32>,
    pub year: Option<u32>,
    pub play_count: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RekordboxBatchRequest {
    pub payloads: Vec<RekordboxApplyPayload>,
    pub options: RekordboxWriteOptions,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanRenameItem {
    pub path: String,
    pub cleaned_display: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanRenameBatchRequest {
    pub items: Vec<CleanRenameItem>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSnapshot {
    pub artist: Option<String>,
    pub title: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub track_number: Option<u32>,
    pub year: Option<u32>,
    /// True when the file already has embedded front (or first) cover art.
    #[serde(default)]
    pub has_embedded_cover: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanedFilename {
    pub display: String,
    pub search_artist: String,
    pub search_title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedTrack {
    pub path: String,
    /// Base file name (e.g. `track.mp3`).
    pub file_name: String,
    pub filename_stem: String,
    pub cleaned: CleanedFilename,
    pub current: TagSnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    pub path: String,
    pub file_name: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanFolderResult {
    pub tracks: Vec<ScannedTrack>,
    pub skipped: Vec<SkippedFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverOption {
    pub url: String,
    pub source: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub score: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupCandidate {
    pub recording_mbid: String,
    pub release_mbid: String,
    pub artist: String,
    pub title: String,
    pub album: String,
    pub album_artist: Option<String>,
    pub track_number: Option<u32>,
    pub year: Option<u32>,
    pub cover_url: Option<String>,
    #[serde(default)]
    pub cover_options: Vec<CoverOption>,
    pub score: Option<i32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupInput {
    pub path: String,
    pub artist: String,
    pub title: String,
    /// Raw file stem (before cleaning); drives optional iTunes filename hints.
    #[serde(default)]
    pub filename_stem: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupResult {
    pub path: String,
    pub candidates: Vec<LookupCandidate>,
    pub confidence: String,
    pub artist_guesses: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyAuthResult {
    pub ok: bool,
    pub expires_in: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPayload {
    pub path: String,
    pub artist: String,
    pub title: String,
    pub album: String,
    pub album_artist: Option<String>,
    pub track_number: Option<u32>,
    pub year: Option<u32>,
    pub cover_url: Option<String>,
    /// MusicBrainz release MBID for Cover Art Archive JSON fallback.
    pub release_mbid: Option<String>,
    /// User chose "None (remove cover)" — strip embedded art; do not reuse file cover.
    #[serde(default)]
    pub remove_embedded_cover: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    pub path: String,
    pub final_path: Option<String>,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanRenameOutcome {
    pub path: String,
    pub next_path: Option<String>,
    pub ok: bool,
    pub error: Option<String>,
}

/// Used only for serde from frontend; merged in `apply_batch` with per-file payloads.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyBatchRequest {
    pub payloads: Vec<ApplyPayload>,
    pub meta: ApplyMetadataOptions,
    #[serde(default)]
    pub rename: RenameOptions,
}
