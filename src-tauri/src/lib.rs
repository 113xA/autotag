mod amazon;
mod cover_art;
mod deezer;
mod filename_catalog;
mod filename_clean;
mod metadata;
mod models;
mod musicbrainz;
mod options;
mod rekordbox_xml;
mod smart_lookup;
mod spotify;
mod youtube;

use std::path::{Path, PathBuf};
use std::time::Instant;

use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;
use tauri::Emitter;
use tauri::Manager;
use walkdir::WalkDir;

use crate::cover_art::{placeholder_cover_png_bytes, resolve_cover_art, CoverResolveParams};
use crate::filename_clean::clean_filename_stem;
use crate::metadata::{
    build_rename_path, preview_rename_filename, read_tag_snapshot, sanitize_path_component,
    unique_available_path, write_rekordbox_tags,
    write_tags, WriteTagInput,
};
use crate::models::{
    ApplyBatchRequest, ApplyOutcome, ApplyPayload, CleanRenameBatchRequest, CleanRenameOutcome,
    LookupInput, LookupResult, RekordboxBatchRequest, RekordboxWriteOptions, ScannedTrack,
    SpotifyAuthResult,
};
use crate::musicbrainz::MbState;
use crate::options::{
    ApplyMetadataOptions, CleaningOptions, MatchingOptions, ProgressPayload, RenameOptions,
};
use crate::rekordbox_xml::{match_rekordbox_xml_to_paths, RekordboxMatchSummary};
use crate::spotify::SpotifyState;

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
    deezer: tauri::State<'_, deezer::DeezerState>,
    spotify: tauri::State<'_, SpotifyState>,
    amazon: tauri::State<'_, amazon::AmazonState>,
    youtube: tauri::State<'_, youtube::YoutubeState>,
    items: Vec<LookupInput>,
    matching: MatchingOptions,
    run_id: u64,
) -> Result<Vec<LookupResult>, String> {
    #[derive(Serialize, Clone)]
    struct LookupResultEvent<'a> {
        run_id: u64,
        result: &'a LookupResult,
    }

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
    if matching.verbose_logs {
        eprintln!(
            "[batch_lookup] start total={} items kind=lookup",
            total
        );
    }
    let client = state.client.clone();
    let mut results = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let started = Instant::now();
        if matching.verbose_logs {
            eprintln!(
                "[batch_lookup] ({}/{}) start path={}",
                i + 1,
                total,
                item.path
            );
        }
        let one = smart_lookup::smart_lookup_one(
            &state,
            &client,
            &deezer,
            &spotify,
            &amazon,
            &youtube,
            item,
            &matching,
        )
        .await?;

        let _ = app.emit(
            "lookup_result",
            LookupResultEvent {
                run_id,
                result: &one,
            },
        );

        results.push(one);
        if matching.verbose_logs {
            eprintln!(
                "[batch_lookup] ({}/{}) done path={} candidates={} coverOptionsFirst={:?} elapsedMs={}",
                i + 1,
                total,
                item.path,
                results
                    .last()
                    .map(|r| r.candidates.len())
                    .unwrap_or(0),
                results
                    .last()
                    .and_then(|r| r.candidates.first())
                    .map(|c| c.cover_options.len()),
                started.elapsed().as_millis()
            );
        }
        emit_progress(
            &app,
            ProgressPayload {
                kind: "lookup".into(),
                done: (i + 1) as u32,
                total,
                message: Some(item.path.clone()),
            },
        );
    }
    if matching.verbose_logs {
        eprintln!("[batch_lookup] done total={}", total);
    }
    Ok(results)
}

fn session_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("session_state.sqlite3"))
}

fn ensure_session_schema(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS session_state (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            payload TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn save_session_snapshot(app: tauri::AppHandle, snapshot: Value) -> Result<(), String> {
    let db = session_db_path(&app)?;
    let payload = serde_json::to_string(&snapshot).map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || {
        let mut conn = Connection::open(db).map_err(|e| e.to_string())?;
        ensure_session_schema(&conn)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO session_state(id, payload, updated_at)
             VALUES(1, ?1, unixepoch())
             ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at",
            params![payload],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn load_session_snapshot(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    let db = session_db_path(&app)?;
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(db).map_err(|e| e.to_string())?;
        ensure_session_schema(&conn)?;
        let mut stmt = conn
            .prepare("SELECT payload FROM session_state WHERE id=1")
            .map_err(|e| e.to_string())?;
        let row = stmt.query_row([], |r| r.get::<_, String>(0));
        match row {
            Ok(payload) => {
                let parsed = serde_json::from_str::<Value>(&payload).map_err(|e| e.to_string())?;
                Ok(Some(parsed))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn clear_session_snapshot(app: tauri::AppHandle) -> Result<(), String> {
    let db = session_db_path(&app)?;
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(db).map_err(|e| e.to_string())?;
        ensure_session_schema(&conn)?;
        conn.execute("DELETE FROM session_state WHERE id=1", [])
            .map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn musicbrainz_lookup_one(
    state: tauri::State<'_, MbState>,
    item: LookupInput,
    matching: MatchingOptions,
) -> Result<LookupResult, String> {
    smart_lookup::musicbrainz_only_lookup_one(&state, &item, &matching).await
}

#[tauri::command]
async fn spotify_auth(
    state: tauri::State<'_, MbState>,
    spotify: tauri::State<'_, SpotifyState>,
    client_id: String,
    client_secret: String,
) -> Result<SpotifyAuthResult, String> {
    let expires_in = spotify::auth_client_credentials(
        &spotify,
        &state.client,
        &client_id,
        &client_secret,
    )
    .await?;
    Ok(SpotifyAuthResult {
        ok: true,
        expires_in,
    })
}

#[tauri::command]
async fn spotify_auth_browser(
    state: tauri::State<'_, MbState>,
    spotify: tauri::State<'_, SpotifyState>,
    client_id: String,
) -> Result<SpotifyAuthResult, String> {
    let expires_in = spotify::auth_browser_pkce(&spotify, &state.client, &client_id).await?;
    Ok(SpotifyAuthResult {
        ok: true,
        expires_in,
    })
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
    let rename = req.rename.clone();
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
        let res = apply_one(&client, payload, &meta, &rename).await;
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
fn preview_rename(
    path: String,
    artist: String,
    title: String,
    album: String,
    year: Option<u32>,
    rename: RenameOptions,
) -> Result<String, String> {
    preview_rename_filename(&path, &artist, &title, &album, year, &rename)
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

#[tauri::command]
async fn clean_rename_batch(req: CleanRenameBatchRequest) -> Result<Vec<CleanRenameOutcome>, String> {
    let mut outcomes = Vec::with_capacity(req.items.len());
    for item in req.items {
        let p = Path::new(&item.path);
        let parent = match p.parent() {
            Some(v) => v,
            None => {
                outcomes.push(CleanRenameOutcome {
                    path: item.path,
                    next_path: None,
                    ok: false,
                    error: Some("no parent directory".into()),
                });
                continue;
            }
        };
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        let stem = sanitize_path_component(&item.cleaned_display);
        if stem.is_empty() {
            outcomes.push(CleanRenameOutcome {
                path: item.path,
                next_path: None,
                ok: false,
                error: Some("cleaned name is empty".into()),
            });
            continue;
        }
        let candidate = if ext.is_empty() {
            parent.join(stem)
        } else {
            parent.join(format!("{stem}.{ext}"))
        };
        let next = match unique_available_path(candidate) {
            Ok(v) => v,
            Err(e) => {
                outcomes.push(CleanRenameOutcome {
                    path: item.path,
                    next_path: None,
                    ok: false,
                    error: Some(e),
                });
                continue;
            }
        };
        if next == p {
            outcomes.push(CleanRenameOutcome {
                path: item.path.clone(),
                next_path: Some(item.path),
                ok: true,
                error: None,
            });
            continue;
        }
        match std::fs::rename(p, &next) {
            Ok(()) => outcomes.push(CleanRenameOutcome {
                path: item.path,
                next_path: Some(next.to_string_lossy().to_string()),
                ok: true,
                error: None,
            }),
            Err(e) => outcomes.push(CleanRenameOutcome {
                path: item.path,
                next_path: None,
                ok: false,
                error: Some(e.to_string()),
            }),
        }
    }
    Ok(outcomes)
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
    rename: &RenameOptions,
) -> Result<(), String> {
    let (cover_bytes, mime_hint): (Option<Vec<u8>>, Option<String>) = if meta.embed_cover {
        let resolved = resolve_cover_art(
            client,
            CoverResolveParams {
                primary_url: payload.cover_url.as_deref(),
                release_mbid: payload.release_mbid.as_deref(),
                artist: &payload.artist,
                title: &payload.title,
                album: &payload.album,
                try_itunes_fallback: meta.try_itunes_cover_fallback,
            },
        )
        .await;
        if let Some((b, m)) = resolved {
            (Some(b), m)
        } else if meta.embed_placeholder_when_no_art {
            (
                Some(placeholder_cover_png_bytes().to_vec()),
                Some("image/png".into()),
            )
        } else {
            (None, None)
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
    let meta = meta.clone();
    let rename = rename.clone();

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
        if rename.enabled {
            let new_path = build_rename_path(
                &path,
                &artist,
                &title,
                &album,
                year,
                &rename,
            )?;
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
        .manage(deezer::DeezerState::new())
        .manage(SpotifyState::new())
        .manage(amazon::AmazonState::new())
        .manage(youtube::YoutubeState::new())
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            batch_lookup,
            apply_batch,
            preview_rename,
            clean_rename_batch,
            spotify_auth,
            spotify_auth_browser,
            save_session_snapshot,
            load_session_snapshot,
            clear_session_snapshot,
            musicbrainz_lookup_one,
            match_rekordbox_library,
            apply_rekordbox_batch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
