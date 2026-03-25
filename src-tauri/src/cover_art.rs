//! Multi-source cover art fetch: primary URL, Cover Art Archive JSON, optional iTunes.

use std::sync::OnceLock;
use std::time::Duration;

use reqwest::header::{ACCEPT, CONTENT_TYPE, USER_AGENT};
use reqwest::Client;
use serde_json::Value;
use url::Url;

const UA: &str = "LibraryAutotag/0.1.0 (cover resolver)";

fn looks_like_image(bytes: &[u8]) -> bool {
    if bytes.len() < 12 {
        return false;
    }
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        return true;
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return true;
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        return true;
    }
    false
}

async fn try_fetch_url(client: &Client, url: &str) -> Option<(Vec<u8>, Option<String>)> {
    let resp = client
        .get(url)
        .header(USER_AGENT, UA)
        .timeout(Duration::from_secs(25))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let mime = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let bytes = resp.bytes().await.ok()?.to_vec();
    if !looks_like_image(&bytes) {
        return None;
    }
    Some((bytes, mime))
}

/// Collect candidate image URLs from a CAA release JSON document.
fn caa_image_urls(v: &Value) -> Vec<String> {
    let Some(images) = v.get("images").and_then(|x| x.as_array()) else {
        return vec![];
    };

    let mut rows: Vec<(bool, Vec<String>)> = Vec::new();
    for img in images {
        let is_front = img
            .get("types")
            .and_then(|t| t.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str())
                    .any(|s| s.eq_ignore_ascii_case("front"))
            })
            .unwrap_or(false)
            || img.get("front").and_then(|x| x.as_bool()).unwrap_or(false);

        let mut urls: Vec<String> = Vec::new();
        if let Some(th) = img.get("thumbnails").and_then(|x| x.as_object()) {
            for key in ["2500", "1200", "500", "large", "250", "small"] {
                if let Some(u) = th.get(key).and_then(|x| x.as_str()) {
                    urls.push(u.to_string());
                }
            }
        }
        if let Some(u) = img.get("image").and_then(|x| x.as_str()) {
            urls.push(u.to_string());
        }
        urls.dedup();
        if !urls.is_empty() {
            rows.push((is_front, urls));
        }
    }

    rows.sort_by_key(|(front, _)| !front);
    rows.into_iter().flat_map(|(_, u)| u).collect()
}

async fn fetch_caa_urls(client: &Client, release_mbid: &str) -> Vec<String> {
    let mbid = release_mbid.trim();
    if mbid.is_empty() {
        return vec![];
    }
    let url = format!("https://coverartarchive.org/release/{mbid}");
    let resp = match client
        .get(&url)
        .header(USER_AGENT, UA)
        .header(ACCEPT, "application/json")
        .timeout(Duration::from_secs(20))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    if !resp.status().is_success() {
        return vec![];
    }
    let Ok(v) = resp.json::<Value>().await else {
        return vec![];
    };
    caa_image_urls(&v)
}

fn itunes_search_url(term: &str) -> Option<String> {
    let mut u = Url::parse("https://itunes.apple.com/search").ok()?;
    {
        let mut q = u.query_pairs_mut();
        q.append_pair("term", term);
        q.append_pair("entity", "song");
        q.append_pair("limit", "5");
    }
    Some(u.to_string())
}

async fn fetch_itunes_cover(client: &Client, artist: &str, title: &str, album: &str) -> Option<String> {
    let t1 = format!("{artist} {title}");
    let urls = [t1, format!("{artist} {title} {album}")];
    for term in urls {
        let Some(api) = itunes_search_url(&term) else {
            continue;
        };
        let resp = match client
            .get(&api)
            .header(USER_AGENT, UA)
            .timeout(Duration::from_secs(20))
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => continue,
        };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(v) = resp.json::<Value>().await else {
            continue;
        };
        let Some(results) = v.get("results").and_then(|x| x.as_array()) else {
            continue;
        };
        for r in results {
            if let Some(u) = r.get("artworkUrl100").and_then(|x| x.as_str()) {
                let hi = u.replace("100x100", "600x600");
                return Some(hi);
            }
        }
    }
    None
}

pub struct CoverResolveParams<'a> {
    pub primary_url: Option<&'a str>,
    pub release_mbid: Option<&'a str>,
    pub artist: &'a str,
    pub title: &'a str,
    pub album: &'a str,
    pub try_itunes_fallback: bool,
}

/// Returns image bytes and optional MIME, or None if nothing worked.
pub async fn resolve_cover_art(client: &Client, p: CoverResolveParams<'_>) -> Option<(Vec<u8>, Option<String>)> {
    let mut tried = std::collections::HashSet::<String>::new();

    if let Some(u) = p.primary_url.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(r) = try_fetch_url(client, u).await {
            return Some(r);
        }
        tried.insert(u.to_string());
    }

    if let Some(mbid) = p.release_mbid.map(str::trim).filter(|s| !s.is_empty()) {
        for u in fetch_caa_urls(client, mbid).await {
            if tried.contains(&u) {
                continue;
            }
            tried.insert(u.clone());
            if let Some(r) = try_fetch_url(client, &u).await {
                return Some(r);
            }
        }
    }

    if p.try_itunes_fallback {
        if let Some(u) = fetch_itunes_cover(client, p.artist, p.title, p.album).await {
            if !tried.contains(&u) {
                if let Some(r) = try_fetch_url(client, &u).await {
                    return Some(r);
                }
            }
        }
    }

    None
}

// —— Placeholder cover (teal X on dark panel) ——

static PLACEHOLDER_PNG: OnceLock<Vec<u8>> = OnceLock::new();

pub fn placeholder_cover_png_bytes() -> &'static [u8] {
    PLACEHOLDER_PNG.get_or_init(build_x_placeholder_png)
}

fn build_x_placeholder_png() -> Vec<u8> {
    const W: usize = 128;
    const H: usize = 128;
    let mut buf = vec![0u8; W * H * 4];
    let bg = [0x12u8, 0x15, 0x1c, 0xff];
    let fg = [52u8, 211, 201, 255];
    for px in buf.chunks_mut(4) {
        px.copy_from_slice(&bg);
    }
    let thick = 7i32;
    for y in 0..H as i32 {
        for x in 0..W as i32 {
            let d1 = (x - y).abs();
            let d2 = (x - ((W as i32) - 1 - y)).abs();
            if d1 <= thick || d2 <= thick {
                let i = ((y as usize) * W + (x as usize)) * 4;
                buf[i..i + 4].copy_from_slice(&fg);
            }
        }
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, W as u32, H as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        if let Ok(mut w) = enc.write_header() {
            let _ = w.write_image_data(&buf);
        }
    }
    if out.is_empty() {
        return vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
    }
    out
}
