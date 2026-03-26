use std::time::Duration;

use reqwest::Client;
use serde_json::Value;
use tokio::sync::Mutex;

const UA: &str = "LibraryAutotag/0.1.0 (deezer)";

#[derive(Debug, Clone)]
pub struct DeezerTrackHit {
    pub artist: String,
    pub title: String,
    pub album: Option<String>,
    pub cover_url: Option<String>,
    pub year: Option<u32>,
}

pub struct DeezerState {
    gate: Mutex<()>,
}

impl DeezerState {
    pub fn new() -> Self {
        Self {
            gate: Mutex::new(()),
        }
    }
}

pub async fn search_tracks(
    state: &DeezerState,
    client: &Client,
    query: &str,
    limit: usize,
) -> Vec<DeezerTrackHit> {
    let _guard = state.gate.lock().await;
    let out = search_tracks_inner(client, query, limit).await;
    tokio::time::sleep(Duration::from_millis(350)).await;
    out
}

async fn search_tracks_inner(client: &Client, query: &str, limit: usize) -> Vec<DeezerTrackHit> {
    let q = query.trim();
    if q.is_empty() {
        return vec![];
    }
    let url = format!("https://api.deezer.com/search?q={}", urlencoding::encode(q));
    let resp = match client
        .get(url)
        .header(reqwest::header::USER_AGENT, UA)
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
    let Some(rows) = v.get("data").and_then(|x| x.as_array()) else {
        return vec![];
    };
    rows.iter()
        .take(limit.max(1))
        .filter_map(|r| {
            let artist = r
                .get("artist")
                .and_then(|a| a.get("name"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let title = r
                .get("title")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if artist.is_empty() || title.is_empty() {
                return None;
            }
            let album = r
                .get("album")
                .and_then(|a| a.get("title"))
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
            let cover_url = r
                .get("album")
                .and_then(|a| a.get("cover_xl").or_else(|| a.get("cover_big")).or_else(|| a.get("cover")))
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
            let year = r
                .get("release_date")
                .and_then(|x| x.as_str())
                .and_then(|s| s.get(0..4))
                .and_then(|y| y.parse::<u32>().ok());
            Some(DeezerTrackHit {
                artist,
                title,
                album,
                cover_url,
                year,
            })
        })
        .collect()
}
