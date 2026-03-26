use std::time::Duration;

use reqwest::Client;
use serde_json::Value;
use tokio::sync::Mutex;

const UA: &str = "LibraryAutotag/0.1.0 (itunes-cover-search)";

#[derive(Debug, Clone)]
pub struct AmazonCoverHit {
    pub url: String,
}

#[derive(Debug, Clone)]
pub struct ItunesTrackHit {
    pub artist: String,
    pub title: String,
    pub album: Option<String>,
    pub year: Option<u32>,
    pub cover_url: Option<String>,
}

pub struct AmazonState {
    gate: Mutex<()>,
}

impl AmazonState {
    pub fn new() -> Self {
        Self {
            gate: Mutex::new(()),
        }
    }
}

pub async fn search_cover_urls(
    state: &AmazonState,
    client: &Client,
    artist: &str,
    title: &str,
    limit: usize,
    verbose_logs: bool,
) -> Vec<AmazonCoverHit> {
    let _guard = state.gate.lock().await;
    let out = search_cover_urls_inner(client, artist, title, limit, verbose_logs).await;
    tokio::time::sleep(Duration::from_millis(220)).await;
    out
}

pub async fn search_tracks(
    state: &AmazonState,
    client: &Client,
    artist: &str,
    title: &str,
    limit: usize,
    verbose_logs: bool,
) -> Vec<ItunesTrackHit> {
    let _guard = state.gate.lock().await;
    let out = search_tracks_inner(client, artist, title, limit, verbose_logs).await;
    tokio::time::sleep(Duration::from_millis(220)).await;
    out
}

async fn search_cover_urls_inner(
    client: &Client,
    artist: &str,
    title: &str,
    limit: usize,
    verbose_logs: bool,
) -> Vec<AmazonCoverHit> {
    let q = format!("{} {}", artist.trim(), title.trim())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if q.is_empty() {
        return vec![];
    }

    let url = format!(
        "https://itunes.apple.com/search?media=music&entity=song&limit=25&term={}",
        urlencoding::encode(&q)
    );
    if verbose_logs {
        eprintln!(
            "[itunes-covers] term='{}' requesting limit={} (query='{}')",
            title.trim(),
            limit,
            q
        );
    }
    let resp = match client
        .get(url)
        .header(reqwest::header::USER_AGENT, UA)
        .timeout(Duration::from_secs(12))
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
    let Some(rows) = v.get("results").and_then(|x| x.as_array()) else {
        return vec![];
    };
    let mut out: Vec<AmazonCoverHit> = Vec::new();
    for r in rows {
        let url = r
            .get("artworkUrl100")
            .and_then(|x| x.as_str())
            .map(upscale_itunes_artwork_url);
        let Some(url) = url else {
            continue;
        };
        if !out.iter().any(|u| u.url == url) {
            out.push(AmazonCoverHit { url });
            if out.len() >= limit.max(1) {
                break;
            }
        }
    }
    if verbose_logs {
        eprintln!(
            "[itunes-covers] term='{}' results={} returning={}",
            title.trim(),
            rows.len(),
            out.len()
        );
    }
    out
}

fn upscale_itunes_artwork_url(url: &str) -> String {
    url.replace("100x100bb", "1200x1200bb")
        .replace("100x100-75", "1200x1200-100")
}

async fn search_tracks_inner(
    client: &Client,
    artist: &str,
    title: &str,
    limit: usize,
    verbose_logs: bool,
) -> Vec<ItunesTrackHit> {
    let q = format!("{} {}", artist.trim(), title.trim())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if q.is_empty() {
        return vec![];
    }
    let url = format!(
        "https://itunes.apple.com/search?media=music&entity=song&limit=25&term={}",
        urlencoding::encode(&q)
    );
    if verbose_logs {
        eprintln!("[itunes-tracks] query='{}' limit={}", q, limit);
    }
    let resp = match client
        .get(url)
        .header(reqwest::header::USER_AGENT, UA)
        .timeout(Duration::from_secs(12))
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
    let Some(rows) = v.get("results").and_then(|x| x.as_array()) else {
        return vec![];
    };
    let mut out = Vec::<ItunesTrackHit>::new();
    for r in rows {
        let artist = r
            .get("artistName")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let title = r
            .get("trackName")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if artist.is_empty() || title.is_empty() {
            continue;
        }
        let album = r
            .get("collectionName")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let year = r
            .get("releaseDate")
            .and_then(|x| x.as_str())
            .and_then(|s| s.get(0..4))
            .and_then(|y| y.parse::<u32>().ok());
        let cover_url = r
            .get("artworkUrl100")
            .and_then(|x| x.as_str())
            .map(upscale_itunes_artwork_url);
        if out.iter().any(|h| {
            h.artist.eq_ignore_ascii_case(&artist) && h.title.eq_ignore_ascii_case(&title)
        }) {
            continue;
        }
        out.push(ItunesTrackHit {
            artist,
            title,
            album,
            year,
            cover_url,
        });
        if out.len() >= limit.max(1) {
            break;
        }
    }
    if verbose_logs {
        eprintln!("[itunes-tracks] query='{}' returning={}", q, out.len());
    }
    out
}
