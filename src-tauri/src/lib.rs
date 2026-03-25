mod filename_clean;
mod metadata;
mod models;
mod musicbrainz;
mod options;
mod rekordbox_xml;

use std::path::Path;

use reqwest::header::CONTENT_TYPE;
use tauri::Emitter;
use walkdir::WalkDir;

use crate::filename_clean::clean_filename_stem;
use crate::metadata::{
    build_rename_path, preview_rename_filename, read_tag_snapshot, write_rekordbox_tags,
    write_tags, WriteTagInput,
};
use crate::models::{
    ApplyBatchRequest, ApplyOutcome, ApplyPayload, LookupInput, LookupResult, RekordboxBatchRequest,
    RekordboxWriteOptions, ScannedTrack,
};
use crate::musicbrainz::MbState;
use crate::options::{ApplyMetadataOptions, CleaningOptions, MatchingOptions, ProgressPayload};
use crate::rekordbox_xml::{match_rekordbox_xml_to_paths, RekordboxMatchSummary};

const AUDIO_EXT: &[&str] = &["mp3", "flac", "m4a", "mp4", "ogg", "opus"];

fn emit_progress(app: &tauri::AppHandle, p: ProgressPayload) {
    let _ = app.emit("progress", p);
}

#[tauri::command]
async fn scan_folder(
    app: tauri::AppHandle,
    path: String,
    cleaning: CleaningOptions,
) -> Result<Vec<ScannedTrack>, String> {
    let app2 = app.clone();
    tokio::task::spawn_blocking(move || scan_folder_sync(app2, path, cleaning))
        .await
        .map_err(|e| e.to_string())?
}

fn scan_folder_sync(
    app: tauri::AppHandle,
    path: String,
    cleaning: CleaningOptions,
) -> Result<Vec<ScannedTrack>, String> {
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err("not a directory".into());
    }
    let mut paths = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase());
        let Some(ext) = ext else {
            continue;
        };
        if !AUDIO_EXT.contains(&ext.as_str()) {
            continue;
        }
        paths.push(p.to_path_buf());
    }
    paths.sort();
    let total = paths.len() as u32;
    emit_progress(
        &app,
        ProgressPayload {
            kind: "scan".into(),
            done: 0,
            total,
            message: Some("Reading files…".into()),
        },
    );
    if total == 0 {
        return Ok(vec![]);
    }

    let mut tracks = Vec::with_capacity(paths.len());
    for (i, p) in paths.iter().enumerate() {
        let path_str = p.to_string_lossy().to_string();
        let file_name = p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let stem = p
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let cleaned = clean_filename_stem(&stem, &cleaning);
        let current = read_tag_snapshot(&path_str);
        tracks.push(ScannedTrack {
            path: path_str,
            file_name,
            filename_stem: stem,
            cleaned,
            current,
        });
        let done = (i + 1) as u32;
        let emit = done == total || done % 5 == 0 || paths.len() < 20;
        if emit {
            emit_progress(
                &app,
                ProgressPayload {
                    kind: "scan".into(),
                    done,
                    total,
                    message: None,
                },
            );
        }
    }
    tracks.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(tracks)
}

#[tauri::command]
async fn batch_lookup(
    app: tauri::AppHandle,
    state: tauri::State<'_, MbState>,
    items: Vec<LookupInput>,
    matching: MatchingOptions,
) -> Result<Vec<LookupResult>, String> {
    let total = items.len() as u32;
    emit_progress(
        &app,
        ProgressPayload {
            kind: "lookup".into(),
            done: 0,
            total,
            message: None,
        },
    );
    let mut results = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let candidates = state
            .lookup(&item.artist, &item.title, &matching)
            .await?;
        results.push(LookupResult {
            path: item.path.clone(),
            candidates,
        });
        emit_progress(
            &app,
            ProgressPayload {
                kind: "lookup".into(),
                done: (i + 1) as u32,
                total,
                message: None,
            },
        );
    }
    Ok(results)
}

#[tauri::command]
async fn apply_batch(
    app: tauri::AppHandle,
    state: tauri::State<'_, MbState>,
    req: ApplyBatchRequest,
) -> Result<Vec<ApplyOutcome>, String> {
    let client = state.client.clone();
    let total = req.payloads.len() as u32;
    let meta = req.meta;
    emit_progress(
        &app,
        ProgressPayload {
            kind: "apply".into(),
            done: 0,
            total,
            message: None,
        },
    );
    let mut outcomes = Vec::with_capacity(req.payloads.len());
    for (i, payload) in req.payloads.into_iter().enumerate() {
        let path = payload.path.clone();
        let res = apply_one(&client, payload, &meta).await;
        outcomes.push(match res {
            Ok(()) => ApplyOutcome {
                path,
                ok: true,
                error: None,
            },
            Err(e) => ApplyOutcome {
                path,
                ok: false,
                error: Some(e),
            },
        });
        emit_progress(
            &app,
            ProgressPayload {
                kind: "apply".into(),
                done: (i + 1) as u32,
                total,
                message: None,
            },
        );
    }
    Ok(outcomes)
}

#[tauri::command]
fn preview_rename(path: String, artist: String, title: String) -> Result<String, String> {
    preview_rename_filename(&path, &artist, &title)
}

#[tauri::command]
async fn match_rekordbox_library(
    xml_path: String,
    paths: Vec<String>,
) -> Result<RekordboxMatchSummary, String> {
    tokio::task::spawn_blocking(move || {
        match_rekordbox_xml_to_paths(Path::new(&xml_path), &paths)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn rekordbox_write_options_active(o: &RekordboxWriteOptions) -> bool {
    o.write_bpm
        || o.write_key
        || o.write_rating
        || o.write_play_counter
        || o.write_comment
        || o.append_play_count_to_comment
        || o.write_remixer
        || o.write_label
        || o.write_genre
        || o.write_grouping
        || o.write_track_number
        || o.write_disc_number
        || o.write_year
        || o.write_artist_title_album
}

#[tauri::command]
async fn apply_rekordbox_batch(
    app: tauri::AppHandle,
    req: RekordboxBatchRequest,
) -> Result<Vec<ApplyOutcome>, String> {
    if req.payloads.is_empty() {
        return Err("no files to update".into());
    }
    if !rekordbox_write_options_active(&req.options) {
        return Err("enable at least one Rekordbox field in settings".into());
    }
    let total = req.payloads.len() as u32;
    let opts = req.options.clone();
    emit_progress(
        &app,
        ProgressPayload {
            kind: "rekordbox".into(),
            done: 0,
            total,
            message: None,
        },
    );
    let mut outcomes = Vec::with_capacity(req.payloads.len());
    for (i, payload) in req.payloads.into_iter().enumerate() {
        let path = payload.path.clone();
        let opts_i = opts.clone();
        let res = tokio::task::spawn_blocking(move || {
            write_rekordbox_tags(&payload.path, &payload, &opts_i)
        })
        .await
        .map_err(|e| e.to_string())?;
        outcomes.push(match res {
            Ok(()) => ApplyOutcome {
                path,
                ok: true,
                error: None,
            },
            Err(e) => ApplyOutcome {
                path,
                ok: false,
                error: Some(e),
            },
        });
        emit_progress(
            &app,
            ProgressPayload {
                kind: "rekordbox".into(),
                done: (i + 1) as u32,
                total,
                message: None,
            },
        );
    }
    Ok(outcomes)
}

async fn apply_one(
    client: &reqwest::Client,
    payload: ApplyPayload,
    meta: &ApplyMetadataOptions,
) -> Result<(), String> {
    let want_cover = meta.embed_cover && payload.cover_url.is_some();

    let (cover_bytes, mime_hint): (Option<Vec<u8>>, Option<String>) = if want_cover {
        match client
            .get(payload.cover_url.as_ref().unwrap())
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                let mime = resp
                    .headers()
                    .get(CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .map(String::from);
                match resp.bytes().await {
                    Ok(b) => (Some(b.to_vec()), mime),
                    Err(_) => (None, None),
                }
            }
            _ => (None, None),
        }
    } else {
        (None, None)
    };

    let path = payload.path;
    let artist = payload.artist;
    let title = payload.title;
    let album = payload.album;
    let album_artist = payload.album_artist;
    let track_number = payload.track_number;
    let year = payload.year;
    let rename_file = payload.rename_file;
    let meta = meta.clone();

    tokio::task::spawn_blocking(move || {
        if meta.write_tags {
            write_tags(
                &path,
                WriteTagInput {
                    artist: &artist,
                    title: &title,
                    album: &album,
                    album_artist: album_artist.as_deref(),
                    track_number,
                    year,
                    cover_bytes: cover_bytes.as_deref(),
                    cover_mime_hint: mime_hint.as_deref(),
                    embed_cover: meta.embed_cover,
                    genre: meta.genre.as_deref(),
                    grouping: meta.grouping.as_deref(),
                    comment: meta.comment.as_deref(),
                },
            )?;
        }
        if rename_file {
            let new_path = build_rename_path(&path, &artist, &title)?;
            if new_path.as_path() != Path::new(&path) {
                std::fs::rename(&path, &new_path).map_err(|e| e.to_string())?;
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mb = MbState::new().expect("MusicBrainz HTTP client");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(mb)
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            batch_lookup,
            apply_batch,
            preview_rename,
            match_rekordbox_library,
            apply_rekordbox_batch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
