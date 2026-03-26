use std::time::Duration;

use reqwest::Client;
use serde_json::Value;
use tokio::sync::Mutex;

const UA: &str = "LibraryAutotag/0.1.0 (itunes-cover-search)";

#[derive(Debug, Clone)]
pub struct AmazonCoverHit {
    pub url: String,
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
) -> Vec<AmazonCoverHit> {
    let _guard = state.gate.lock().await;
    let out = search_cover_urls_inner(client, artist, title, limit).await;
    tokio::time::sleep(Duration::from_millis(220)).await;
    out
}

async fn search_cover_urls_inner(
    client: &Client,
    artist: &str,
    title: &str,
    limit: usize,
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
    eprintln!(
        "[itunes-covers] term='{}' requesting limit={} (query='{}')",
        title.trim(),
        limit,
        q
    );
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
    eprintln!(
        "[itunes-covers] term='{}' results={} returning={}",
        title.trim(),
        rows.len(),
        out.len()
    );
    out
}

fn upscale_itunes_artwork_url(url: &str) -> String {
    url.replace("100x100bb", "1200x1200bb")
        .replace("100x100-75", "1200x1200-100")
}
