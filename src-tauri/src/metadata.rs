use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::id3::v2::PopularimeterFrame;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::read_from_path;
use lofty::tag::{Accessor, ItemKey, ItemValue, Tag, TagItem};

use crate::models::{RekordboxApplyPayload, RekordboxWriteOptions, TagSnapshot};
use crate::options::RenameOptions;

pub fn read_tag_snapshot(path: &str) -> TagSnapshot {
    let Ok(tagged) = read_from_path(path) else {
        return TagSnapshot::default();
    };
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return TagSnapshot::default();
    };
    TagSnapshot {
        artist: tag.artist().map(|s| s.to_string()),
        title: tag.title().map(|s| s.to_string()),
        album: tag.album().map(|s| s.to_string()),
        album_artist: tag
            .get_string(&ItemKey::AlbumArtist)
            .map(|s| s.to_string()),
        track_number: tag.track(),
        year: tag.year(),
    }
}

pub struct WriteTagInput<'a> {
    pub artist: &'a str,
    pub title: &'a str,
    pub album: &'a str,
    pub album_artist: Option<&'a str>,
    pub track_number: Option<u32>,
    pub year: Option<u32>,
    pub cover_bytes: Option<&'a [u8]>,
    pub cover_mime_hint: Option<&'a str>,
    pub embed_cover: bool,
    pub genre: Option<&'a str>,
    pub grouping: Option<&'a str>,
    pub comment: Option<&'a str>,
}

pub fn write_tags(path: &str, input: WriteTagInput<'_>) -> Result<(), String> {
    let mut tagged = read_from_path(path).map_err(|e| e.to_string())?;
    let primary_type = tagged.primary_tag_type();

    if tagged.primary_tag_mut().is_none() {
        tagged.insert_tag(Tag::new(primary_type));
    }

    let tag = tagged
        .primary_tag_mut()
        .ok_or_else(|| "failed to create tag".to_string())?;

    tag.set_artist(input.artist.to_string());
    tag.set_title(input.title.to_string());
    tag.set_album(input.album.to_string());
    if let Some(aa) = input.album_artist {
        let _ = tag.insert_text(ItemKey::AlbumArtist, aa.to_string());
    } else {
        tag.remove_key(&ItemKey::AlbumArtist);
    }
    if let Some(n) = input.track_number {
        tag.set_track(n);
    } else {
        tag.remove_track();
    }
    if let Some(y) = input.year {
        tag.set_year(y);
    } else {
        tag.remove_year();
    }

    if let Some(g) = input.genre.filter(|s| !s.is_empty()) {
        tag.set_genre(g.to_string());
    } else {
        tag.remove_genre();
    }

    if let Some(g) = input.grouping.filter(|s| !s.is_empty()) {
        let _ = tag.insert_text(ItemKey::ContentGroup, g.to_string());
    } else {
        tag.remove_key(&ItemKey::ContentGroup);
    }

    if let Some(c) = input.comment.filter(|s| !s.is_empty()) {
        tag.set_comment(c.to_string());
    } else {
        tag.remove_comment();
    }

    if input.embed_cover {
        tag.remove_picture_type(PictureType::CoverFront);
        if let Some(bytes) = input.cover_bytes {
            let mime = mime_from_hint(input.cover_mime_hint, bytes);
            let pic =
                Picture::new_unchecked(PictureType::CoverFront, Some(mime), None, bytes.to_vec());
            tag.push_picture(pic);
        }
    }

    tagged
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| e.to_string())
}

fn mime_from_hint(hint: Option<&str>, bytes: &[u8]) -> MimeType {
    if let Some(h) = hint {
        if h.contains("png") {
            return MimeType::Png;
        }
        if h.contains("jpeg") || h.contains("jpg") {
            return MimeType::Jpeg;
        }
    }
    if bytes.len() >= 8 && bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        MimeType::Png
    } else {
        MimeType::Jpeg
    }
}

pub fn sanitize_path_component(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            _ => c,
        })
        .collect::<String>()
        .trim()
        .chars()
        .take(180)
        .collect()
}

pub fn build_rename_path(
    original: &str,
    artist: &str,
    title: &str,
    album: &str,
    year: Option<u32>,
    opts: &RenameOptions,
) -> Result<std::path::PathBuf, String> {
    if !opts.enabled {
        return Err("rename is disabled".into());
    }
    let sep = match opts.separator.as_str() {
        "underscore" => "_",
        "dot" => " · ",
        "dashTight" => "-",
        _ => " - ",
    };
    let mut chunks: Vec<String> = Vec::new();
    if opts.include_artist {
        let s = sanitize_path_component(artist);
        if !s.is_empty() {
            chunks.push(s);
        }
    }
    if opts.include_title {
        let s = sanitize_path_component(title);
        if !s.is_empty() {
            chunks.push(s);
        }
    }
    if opts.part_order == "titleFirst" && chunks.len() == 2 {
        chunks.swap(0, 1);
    }
    if opts.include_album {
        let s = sanitize_path_component(album);
        if !s.is_empty() {
            chunks.push(s);
        }
    }
    if chunks.is_empty() {
        return Err(
            "choose at least one file name part (artist, title, or album) in settings".into(),
        );
    }
    let mut stem = chunks.join(sep);
    if opts.include_year {
        if let Some(y) = year {
            stem.push_str(&format!(" ({y})"));
        }
    }
    let p = std::path::Path::new(original);
    let parent = p
        .parent()
        .ok_or_else(|| "no parent directory".to_string())?;
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp3");
    let base = format!("{stem}.{ext}");
    Ok(unique_path(parent.join(base)))
}

fn unique_path(path: std::path::PathBuf) -> std::path::PathBuf {
    if !path.exists() {
        return path;
    }
    let parent = path.parent().unwrap_or(std::path::Path::new("."));
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    for i in 2..1000 {
        let candidate = if ext.is_empty() {
            parent.join(format!("{stem} ({i})"))
        } else {
            parent.join(format!("{stem} ({i}).{ext}"))
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    path
}

/// Final file name after rename rules (for UI preview).
pub fn preview_rename_filename(
    original: &str,
    artist: &str,
    title: &str,
    album: &str,
    year: Option<u32>,
    rename: &RenameOptions,
) -> Result<String, String> {
    let p = build_rename_path(original, artist, title, album, year, rename)?;
    Ok(p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default())
}

fn rb_rating_to_popm_byte(r: u32) -> u8 {
    if r == 0 {
        return 0;
    }
    if r <= 5 {
        (r.saturating_mul(51)).min(255) as u8
    } else {
        r.min(255) as u8
    }
}

/// Merge Rekordbox DJ metadata into the file’s primary tag (BPM, key, POPM, comments, etc.).
pub fn write_rekordbox_tags(
    path: &str,
    data: &RekordboxApplyPayload,
    opt: &RekordboxWriteOptions,
) -> Result<(), String> {
    let mut tagged = read_from_path(path).map_err(|e| e.to_string())?;
    let primary_type = tagged.primary_tag_type();

    if tagged.primary_tag_mut().is_none() {
        tagged.insert_tag(Tag::new(primary_type));
    }

    let tag = tagged
        .primary_tag_mut()
        .ok_or_else(|| "failed to create tag".to_string())?;

    if opt.write_artist_title_album {
        if let Some(a) = data.artist.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            tag.set_artist(a.to_string());
        }
        if let Some(t) = data.name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            tag.set_title(t.to_string());
        }
        if let Some(al) = data.album.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            tag.set_album(al.to_string());
        }
    }

    if opt.write_bpm {
        if let Some(bpm) = data.average_bpm.filter(|b| *b > 0.0) {
            let s = bpm.round().max(1.0) as u32;
            let s = s.to_string();
            tag.remove_key(&ItemKey::IntegerBpm);
            tag.remove_key(&ItemKey::Bpm);
            let _ = tag.insert_text(ItemKey::IntegerBpm, s.clone());
            let _ = tag.insert_text(ItemKey::Bpm, s);
        }
    }

    if opt.write_key {
        if let Some(k) = data.tonality.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            tag.remove_key(&ItemKey::InitialKey);
            let _ = tag.insert_text(ItemKey::InitialKey, k.to_string());
        }
    }

    let want_popm = (opt.write_rating && data.rating.map(|r| r > 0).unwrap_or(false))
        || (opt.write_play_counter && data.play_count.map(|p| p > 0).unwrap_or(false));
    if want_popm {
        let rating_byte = if opt.write_rating {
            data.rating.map(rb_rating_to_popm_byte).unwrap_or(0)
        } else {
            0
        };
        let counter = if opt.write_play_counter {
            u64::from(data.play_count.unwrap_or(0))
        } else {
            0
        };
        tag.remove_key(&ItemKey::Popularimeter);
        let popm = PopularimeterFrame::new("rekordbox".to_string(), rating_byte, counter);
        let bytes = popm
            .as_bytes()
            .map_err(|e: lofty::error::LoftyError| e.to_string())?;
        tag.insert(TagItem::new(ItemKey::Popularimeter, ItemValue::Binary(bytes)));
    }

    let mut comment = String::new();
    if opt.write_comment {
        if let Some(c) = data.comments.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            comment.push_str(c);
        }
    }
    if opt.append_play_count_to_comment {
        if let Some(pc) = data.play_count.filter(|p| *p > 0) {
            if !comment.is_empty() {
                comment.push('\n');
            }
            comment.push_str(&format!("Play count: {pc}"));
        }
    }
    if !comment.is_empty() {
        tag.set_comment(comment);
    }

    if opt.write_remixer {
        if let Some(r) = data.remixer.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let _ = tag.insert_text(ItemKey::Remixer, r.to_string());
        }
    }

    if opt.write_label {
        if let Some(l) = data.label.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let _ = tag.insert_text(ItemKey::Label, l.to_string());
        }
    }

    if opt.write_genre {
        if let Some(g) = data.genre.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            tag.set_genre(g.to_string());
        }
    }

    if opt.write_grouping {
        if let Some(g) = data.grouping.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let _ = tag.insert_text(ItemKey::ContentGroup, g.to_string());
        }
    }

    if opt.write_track_number {
        if let Some(n) = data.track_number.filter(|n| *n > 0) {
            tag.set_track(n);
        }
    }

    if opt.write_disc_number {
        if let Some(n) = data.disc_number.filter(|n| *n > 0) {
            tag.set_disk(n);
        }
    }

    if opt.write_year {
        if let Some(y) = data.year.filter(|y| *y > 0) {
            tag.set_year(y);
        }
    }

    tagged
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| e.to_string())
}
