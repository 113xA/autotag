//! Local SQLite catalog of scanned music metadata (paths on disk + tags + cleaning hints).
//! Export can omit path/file name for portable archives; import merges portable rows by stable_id
//! when indexing the same tracks again.

use std::fmt::Write as FmtWrite;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

use crate::filename_clean::clean_filename_stem;
use crate::metadata::read_tag_snapshot;
use crate::options::CleaningOptions;

const AUDIO_EXT: &[&str] = &["mp3", "flac", "m4a", "mp4", "ogg", "opus"];

pub fn library_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("music_catalog.sqlite3"))
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS music_catalog (
            path TEXT PRIMARY KEY,
            stable_id TEXT NOT NULL,
            file_name TEXT NOT NULL,
            artist TEXT,
            title TEXT,
            album TEXT,
            album_artist TEXT,
            track_number INTEGER,
            year INTEGER,
            has_embedded_cover INTEGER NOT NULL DEFAULT 0,
            search_artist TEXT NOT NULL,
            search_title TEXT NOT NULL,
            cleaned_display TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_music_catalog_stable ON music_catalog(stable_id);

        CREATE TABLE IF NOT EXISTS catalog_metadata_only (
            stable_id TEXT PRIMARY KEY,
            artist TEXT,
            title TEXT,
            album TEXT,
            album_artist TEXT,
            track_number INTEGER,
            year INTEGER,
            has_embedded_cover INTEGER NOT NULL DEFAULT 0,
            search_artist TEXT NOT NULL DEFAULT '',
            search_title TEXT NOT NULL DEFAULT '',
            cleaned_display TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL
        );
        "#,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn compute_stable_id(
    artist: Option<&str>,
    title: Option<&str>,
    album: Option<&str>,
    year: Option<u32>,
) -> String {
    let a = artist.map(|s| s.trim().to_lowercase()).unwrap_or_default();
    let t = title.map(|s| s.trim().to_lowercase()).unwrap_or_default();
    let al = album.map(|s| s.trim().to_lowercase()).unwrap_or_default();
    let y = year.map(|n| n.to_string()).unwrap_or_default();
    let line = format!("{a}|{t}|{al}|{y}");
    let mut h = Sha256::new();
    h.update(line.as_bytes());
    let d = h.finalize();
    let mut s = String::with_capacity(64);
    for byte in d.iter() {
        let _ = write!(s, "{byte:02x}");
    }
    s
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCatalogEntry {
    pub stable_id: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub file_name: Option<String>,
    pub artist: Option<String>,
    pub title: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub track_number: Option<u32>,
    pub year: Option<u32>,
    #[serde(default)]
    pub has_embedded_cover: bool,
    pub search_artist: String,
    pub search_title: String,
    pub cleaned_display: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryExportDocument {
    pub version: u32,
    pub include_paths: bool,
    pub include_file_name: bool,
    pub tracks: Vec<LibraryCatalogEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryIndexResult {
    pub indexed: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryImportResult {
    pub rows_with_path: u32,
    pub portable_rows: u32,
}

fn row_from_file(path_str: &str, cleaning: &CleaningOptions) -> LibraryCatalogEntry {
    let p = Path::new(path_str);
    let file_name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let cleaned = clean_filename_stem(&stem, cleaning);
    let snap = read_tag_snapshot(path_str);
    let stable_id = compute_stable_id(
        snap.artist.as_deref(),
        snap.title.as_deref(),
        snap.album.as_deref(),
        snap.year,
    );
    LibraryCatalogEntry {
        stable_id,
        path: Some(path_str.to_string()),
        file_name: Some(file_name),
        artist: snap.artist.clone(),
        title: snap.title.clone(),
        album: snap.album.clone(),
        album_artist: snap.album_artist.clone(),
        track_number: snap.track_number,
        year: snap.year,
        has_embedded_cover: snap.has_embedded_cover,
        search_artist: cleaned.search_artist.clone(),
        search_title: cleaned.search_title.clone(),
        cleaned_display: cleaned.display.clone(),
    }
}

/// If portable metadata exists for this stable_id, overlay tag + cleaning fields (path stays from disk).
fn apply_portable_overlay(conn: &Connection, row: &mut LibraryCatalogEntry) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT artist, title, album, album_artist, track_number, year, has_embedded_cover,
                    search_artist, search_title, cleaned_display
             FROM catalog_metadata_only WHERE stable_id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let found = stmt
        .query_row(params![&row.stable_id], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<u32>>(4)?,
                r.get::<_, Option<u32>>(5)?,
                r.get::<_, i64>(6)? != 0,
                r.get::<_, String>(7)?,
                r.get::<_, String>(8)?,
                r.get::<_, String>(9)?,
            ))
        })
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((
        artist,
        title,
        album,
        album_artist,
        track_number,
        year,
        has_embedded_cover,
        search_artist,
        search_title,
        cleaned_display,
    )) = found
    {
        row.artist = artist;
        row.title = title;
        row.album = album;
        row.album_artist = album_artist;
        row.track_number = track_number;
        row.year = year;
        row.has_embedded_cover = has_embedded_cover;
        row.search_artist = search_artist;
        row.search_title = search_title;
        row.cleaned_display = cleaned_display;
        conn.execute(
            "DELETE FROM catalog_metadata_only WHERE stable_id = ?1",
            params![&row.stable_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn upsert_catalog_row(conn: &Connection, row: &LibraryCatalogEntry) -> Result<(), String> {
    let path = row.path.as_deref().ok_or_else(|| "missing path".to_string())?;
    conn.execute(
        "INSERT INTO music_catalog (
            path, stable_id, file_name, artist, title, album, album_artist,
            track_number, year, has_embedded_cover, search_artist, search_title, cleaned_display, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, unixepoch())
        ON CONFLICT(path) DO UPDATE SET
            stable_id = excluded.stable_id,
            file_name = excluded.file_name,
            artist = excluded.artist,
            title = excluded.title,
            album = excluded.album,
            album_artist = excluded.album_artist,
            track_number = excluded.track_number,
            year = excluded.year,
            has_embedded_cover = excluded.has_embedded_cover,
            search_artist = excluded.search_artist,
            search_title = excluded.search_title,
            cleaned_display = excluded.cleaned_display,
            updated_at = unixepoch()",
        params![
            path,
            &row.stable_id,
            row.file_name.as_deref().unwrap_or(""),
            row.artist,
            row.title,
            row.album,
            row.album_artist,
            row.track_number,
            row.year,
            if row.has_embedded_cover { 1i32 } else { 0i32 },
            &row.search_artist,
            &row.search_title,
            &row.cleaned_display,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn index_folder_sync(
    app: &AppHandle,
    root: String,
    cleaning: CleaningOptions,
) -> Result<LibraryIndexResult, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err("not a directory".into());
    }

    let db_path = library_db_path(app)?;
    let mut conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    ensure_schema(&conn)?;

    let mut paths: Vec<PathBuf> = Vec::new();
    for entry in WalkDir::new(root_path).into_iter().filter_map(|e| e.ok()) {
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

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut n = 0u32;
    for p in paths {
        let path_str = p.to_string_lossy().to_string();
        let mut row = row_from_file(&path_str, &cleaning);
        apply_portable_overlay(&tx, &mut row)?;
        upsert_catalog_row(&tx, &row)?;
        n += 1;
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(LibraryIndexResult { indexed: n })
}

pub fn catalog_count_sync(app: &AppHandle) -> Result<u64, String> {
    let db_path = library_db_path(app)?;
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    ensure_schema(&conn)?;
    let c: u64 = conn
        .query_row("SELECT COUNT(*) FROM music_catalog", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(c)
}

pub fn portable_pending_count_sync(app: &AppHandle) -> Result<u64, String> {
    let db_path = library_db_path(app)?;
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    ensure_schema(&conn)?;
    let c: u64 = conn
        .query_row(
            "SELECT COUNT(*) FROM catalog_metadata_only",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(c)
}

pub fn export_json_sync(
    app: &AppHandle,
    include_paths: bool,
    include_file_name: bool,
) -> Result<String, String> {
    let db_path = library_db_path(app)?;
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    ensure_schema(&conn)?;

    let mut stmt = conn
        .prepare(
            "SELECT stable_id, path, file_name, artist, title, album, album_artist,
                    track_number, year, has_embedded_cover, search_artist, search_title, cleaned_display
             FROM music_catalog ORDER BY path",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(LibraryCatalogEntry {
                stable_id: r.get(0)?,
                path: Some(r.get::<_, String>(1)?),
                file_name: Some(r.get::<_, String>(2)?),
                artist: r.get(3)?,
                title: r.get(4)?,
                album: r.get(5)?,
                album_artist: r.get(6)?,
                track_number: r.get(7)?,
                year: r.get(8)?,
                has_embedded_cover: r.get::<_, i64>(9)? != 0,
                search_artist: r.get(10)?,
                search_title: r.get(11)?,
                cleaned_display: r.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut tracks: Vec<LibraryCatalogEntry> = Vec::new();
    for row in rows {
        let mut e = row.map_err(|e| e.to_string())?;
        if !include_paths {
            e.path = None;
        }
        if !include_file_name {
            e.file_name = None;
        }
        tracks.push(e);
    }

    let doc = LibraryExportDocument {
        version: 1,
        include_paths,
        include_file_name,
        tracks,
    };
    serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())
}

pub fn export_file_sync(
    app: &AppHandle,
    file_path: String,
    include_paths: bool,
    include_file_name: bool,
) -> Result<(), String> {
    let json = export_json_sync(app, include_paths, include_file_name)?;
    fs::write(&file_path, json).map_err(|e| e.to_string())
}

pub fn import_file_sync(app: &AppHandle, file_path: String) -> Result<LibraryImportResult, String> {
    let raw = fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let tracks_val = v
        .get("tracks")
        .ok_or_else(|| "missing tracks array".to_string())?;
    let tracks: Vec<LibraryCatalogEntry> =
        serde_json::from_value(tracks_val.clone()).map_err(|e| e.to_string())?;

    let db_path = library_db_path(app)?;
    let mut conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    ensure_schema(&conn)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let mut rows_with_path = 0u32;
    let mut portable_rows = 0u32;

    for mut e in tracks {
        if e.stable_id.is_empty() {
            e.stable_id = compute_stable_id(
                e.artist.as_deref(),
                e.title.as_deref(),
                e.album.as_deref(),
                e.year,
            );
        }

        if let Some(ref p) = e.path {
            if !p.is_empty() {
                upsert_catalog_row(&tx, &LibraryCatalogEntry {
                    path: e.path.clone(),
                    file_name: e.file_name.clone().or_else(|| {
                        Path::new(p)
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                    }),
                    ..e.clone()
                })?;
                rows_with_path += 1;
                continue;
            }
        }

        // Portable: metadata only (no path / empty path)
        tx.execute(
            "INSERT INTO catalog_metadata_only (
                stable_id, artist, title, album, album_artist, track_number, year,
                has_embedded_cover, search_artist, search_title, cleaned_display, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, unixepoch())
            ON CONFLICT(stable_id) DO UPDATE SET
                artist = excluded.artist,
                title = excluded.title,
                album = excluded.album,
                album_artist = excluded.album_artist,
                track_number = excluded.track_number,
                year = excluded.year,
                has_embedded_cover = excluded.has_embedded_cover,
                search_artist = excluded.search_artist,
                search_title = excluded.search_title,
                cleaned_display = excluded.cleaned_display,
                updated_at = unixepoch()",
            params![
                &e.stable_id,
                e.artist,
                e.title,
                e.album,
                e.album_artist,
                e.track_number,
                e.year,
                if e.has_embedded_cover { 1i32 } else { 0i32 },
                &e.search_artist,
                &e.search_title,
                &e.cleaned_display,
            ],
        )
        .map_err(|e| e.to_string())?;
        portable_rows += 1;
    }

    tx.commit().map_err(|e| e.to_string())?;

    Ok(LibraryImportResult {
        rows_with_path,
        portable_rows,
    })
}

pub fn clear_catalog_sync(app: &AppHandle) -> Result<(), String> {
    let db_path = library_db_path(app)?;
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    ensure_schema(&conn)?;
    conn.execute("DELETE FROM music_catalog", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM catalog_metadata_only", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}
