//! Parse Rekordbox `export.xml` / library XML (`DJ_PLAYLISTS` collection).

use std::collections::HashMap;
use std::path::Path;

use quick_xml::events::BytesStart;
use quick_xml::Reader;
use serde::Serialize;
use url::Url;

/// Result of matching a Rekordbox export to the current scan paths.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RekordboxMatchSummary {
    pub rekordbox_tracks_in_xml: u32,
    pub scanned_paths: u32,
    pub matched_count: u32,
    pub matches: Vec<RekordboxPathMatch>,
}

pub fn match_rekordbox_xml_to_paths(
    xml_path: &Path,
    paths: &[String],
) -> Result<RekordboxMatchSummary, String> {
    let rb = parse_rekordbox_xml_file(xml_path)?;
    let rekordbox_tracks_in_xml = rb.len() as u32;
    let scanned_paths = paths.len() as u32;
    let matches = match_paths_to_rekordbox(&rb, paths);
    let matched_count = matches.iter().filter(|m| m.rekordbox.is_some()).count() as u32;
    Ok(RekordboxMatchSummary {
        rekordbox_tracks_in_xml,
        scanned_paths,
        matched_count,
        matches,
    })
}

/// Stable key for matching Rekordbox `Location` to scanned file paths (OS-aware).
pub fn path_match_key(path: &str) -> String {
    let mut s = path.replace('\\', "/");
    #[cfg(windows)]
    {
        s.make_ascii_lowercase();
    }
    s
}

fn read_xml_as_utf8(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let (cow, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return Ok(cow.into_owned());
    }
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let (cow, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return Ok(cow.into_owned());
    }
    if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        return String::from_utf8(bytes[3..].to_vec()).map_err(|e| e.to_string());
    }
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

fn decode_file_location(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    if let Ok(u) = Url::parse(t) {
        if u.scheme() == "file" {
            return u.to_file_path().ok().and_then(|p| p.to_str().map(|s| s.to_string()));
        }
    }
    let t = t.strip_prefix("file:").unwrap_or(t);
    let t = t.trim_start_matches("//localhost");
    let t = t.trim_start_matches("///");
    let t = t.trim_start_matches("//");
    #[cfg(windows)]
    {
        if t.len() >= 3 && t.as_bytes()[1] == b':' {
            return Some(t.to_string());
        }
        if t.len() >= 4 && t.chars().nth(0) == Some('/') && t.as_bytes()[2] == b':' {
            return Some(t[1..].to_string());
        }
    }
    Some(t.to_string())
}

fn attrs_map(e: &BytesStart<'_>) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for attr in e.attributes().flatten() {
        let Ok(key) = std::str::from_utf8(attr.key.as_ref()) else {
            continue;
        };
        let key = key.to_ascii_lowercase();
        let val = attr.unescape_value().unwrap_or_default().into_owned();
        m.insert(key, val);
    }
    m
}

fn attr_ci<'a>(m: &'a HashMap<String, String>, keys: &[&str]) -> Option<&'a str> {
    for k in keys {
        if let Some(v) = m.get(*k) {
            if !v.is_empty() {
                return Some(v.as_str());
            }
        }
    }
    None
}

fn parse_u32_loose(s: &str) -> Option<u32> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    t.parse::<f64>().ok().map(|n| n as u32)
}

fn parse_f64_loose(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    t.parse::<f64>().ok()
}

/// Tag-related fields extracted from a Rekordbox `TRACK` row.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RekordboxTagSnapshot {
    pub path: String,
    pub match_key: String,
    pub name: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub grouping: Option<String>,
    pub genre: Option<String>,
    pub average_bpm: Option<f64>,
    pub tonality: Option<String>,
    /// Rekordbox `Rating` 0–255 (star scale); `0` means unrated in many exports.
    pub rating: Option<u32>,
    pub comments: Option<String>,
    pub remixer: Option<String>,
    pub label: Option<String>,
    pub track_number: Option<u32>,
    pub disc_number: Option<u32>,
    pub year: Option<u32>,
    pub play_count: Option<u32>,
}

impl RekordboxTagSnapshot {
    fn from_attrs(m: &HashMap<String, String>, path: String) -> Self {
        let match_key = path_match_key(&path);
        let rating_raw = attr_ci(m, &["rating"]).and_then(parse_u32_loose);
        let rating = rating_raw.filter(|&r| r > 0);
        Self {
            path,
            match_key,
            name: attr_ci(m, &["name"]).map(|s| s.to_string()),
            artist: attr_ci(m, &["artist"]).map(|s| s.to_string()),
            album: attr_ci(m, &["album"]).map(|s| s.to_string()),
            grouping: attr_ci(m, &["grouping"]).map(|s| s.to_string()),
            genre: attr_ci(m, &["genre"]).map(|s| s.to_string()),
            average_bpm: attr_ci(m, &["averagebpm", "avgbpm"]).and_then(parse_f64_loose),
            tonality: attr_ci(m, &["tonality", "key"]).map(|s| s.to_string()),
            rating,
            comments: attr_ci(m, &["comments"]).map(|s| s.to_string()),
            remixer: attr_ci(m, &["remixer"]).map(|s| s.to_string()),
            label: attr_ci(m, &["label"]).map(|s| s.to_string()),
            track_number: attr_ci(m, &["tracknumber"]).and_then(parse_u32_loose),
            disc_number: attr_ci(m, &["discnumber"]).and_then(parse_u32_loose),
            year: attr_ci(m, &["year"]).and_then(parse_u32_loose),
            play_count: attr_ci(m, &["playcount"]).and_then(parse_u32_loose),
        }
    }
}

fn track_from_element(e: &BytesStart<'_>) -> Option<RekordboxTagSnapshot> {
    let m = attrs_map(e);
    let loc = attr_ci(&m, &["location"])?;
    let path = decode_file_location(loc)?;
    Some(RekordboxTagSnapshot::from_attrs(&m, path))
}

/// Parse Rekordbox library XML and return one snapshot per `TRACK` (last wins per `match_key`).
pub fn parse_rekordbox_xml_file(xml_path: &Path) -> Result<Vec<RekordboxTagSnapshot>, String> {
    let text = read_xml_as_utf8(xml_path)?;
    parse_rekordbox_xml_str(&text)
}

pub fn parse_rekordbox_xml_str(text: &str) -> Result<Vec<RekordboxTagSnapshot>, String> {
    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut by_key: HashMap<String, RekordboxTagSnapshot> = HashMap::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(quick_xml::events::Event::Start(ref e)) | Ok(quick_xml::events::Event::Empty(ref e)) => {
                if e.name().local_name().as_ref() == b"TRACK" {
                    if let Some(snap) = track_from_element(e) {
                        by_key.insert(snap.match_key.clone(), snap);
                    }
                }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(e) => return Err(e.to_string()),
            _ => {}
        }
        buf.clear();
    }

    let mut v: Vec<_> = by_key.into_values().collect();
    v.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(v)
}

/// Match Rekordbox entries to absolute file paths (e.g. from a folder scan).
pub fn match_paths_to_rekordbox(
    rb: &[RekordboxTagSnapshot],
    paths: &[String],
) -> Vec<RekordboxPathMatch> {
    let map: HashMap<String, &RekordboxTagSnapshot> =
        rb.iter().map(|t| (t.match_key.clone(), t)).collect();
    paths
        .iter()
        .map(|p| {
            let k = path_match_key(p);
            RekordboxPathMatch {
                path: p.clone(),
                rekordbox: map.get(&k).map(|&s| (*s).clone()),
            }
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RekordboxPathMatch {
    pub path: String,
    pub rekordbox: Option<RekordboxTagSnapshot>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_key_windows_lowercase() {
        #[cfg(windows)]
        assert_eq!(
            path_match_key(r"C:\Music\A.mp3"),
            path_match_key(r"c:/music/a.mp3")
        );
        #[cfg(not(windows))]
        assert_eq!(path_match_key("/a/b.mp3"), "/a/b.mp3");
    }

    #[test]
    fn parses_minimal_track() {
        #[cfg(windows)]
        let loc = "file:///C:/Music/rekordbox_rb_test.mp3";
        #[cfg(not(windows))]
        let loc = "file:///tmp/rekordbox_rb_test.mp3";
        let xml = format!(
            r#"<?xml version="1.0"?>
        <DJ_PLAYLISTS><COLLECTION>
        <TRACK Name="T1" Artist="A1" AverageBpm="140" Tonality="Am" Rating="255"
          Location="{loc}" Comments="c1"/>
        </COLLECTION></DJ_PLAYLISTS>"#
        );
        let v = parse_rekordbox_xml_str(&xml).unwrap();
        assert_eq!(v.len(), 1);
        let t = &v[0];
        assert_eq!(t.average_bpm, Some(140.0));
        assert_eq!(t.tonality.as_deref(), Some("Am"));
        assert_eq!(t.rating, Some(255));
        assert!(t.path.contains("rekordbox_rb_test.mp3"));
    }
}
