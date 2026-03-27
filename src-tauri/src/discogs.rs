//! Discogs API integration used for “trusted” verification (track exact-match + cover URL).

use std::time::Duration;

use reqwest::Client;
use serde_json::Value;
use tokio::sync::Mutex;

const UA: &str = "LibraryAutotag/0.1.0 (discogs-track-verify)";

#[derive(Debug, Clone)]
pub struct DiscogsTrackHit {
    pub artist: String,
    pub title: String,
    pub album: Option<String>,
    pub year: Option<u32>,
    pub cover_url: Option<String>,
}

#[derive(Debug)]
pub struct DiscogsState {
    token: String,
    /// Serialize Discogs requests; Discogs rate limits are strict.
    gate: Mutex<()>,
}

impl DiscogsState {
    pub fn new(token: String) -> Self {
        Self {
            token,
            gate: Mutex::new(()),
        }
    }

    fn is_enabled(&self) -> bool {
        !self.token.trim().is_empty()
    }
}

fn normalize_exact(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .filter(|t| t.len() > 1)
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_u32_maybe(v: Option<&Value>) -> Option<u32> {
    let Some(v) = v else {
        return None;
    };
    if let Some(n) = v.as_u64() {
        return Some(n as u32);
    }
    if let Some(s) = v.as_str() {
        return s.get(0..4)?.parse::<u32>().ok();
    }
    None
}

async fn get_json(state: &DiscogsState, client: &Client, url: &str) -> Option<Value> {
    let token = state.token.trim();
    if token.is_empty() {
        return None;
    }

    let resp = match client
        .get(url)
        .header(reqwest::header::USER_AGENT, UA)
        .header(reqwest::header::AUTHORIZATION, format!("Discogs token={}", token))
        .timeout(Duration::from_secs(20))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return None,
    };

    if !resp.status().is_success() {
        return None;
    }

    match resp.json::<Value>().await {
        Ok(v) => Some(v),
        Err(_) => None,
    }
}

/// Search Discogs for track hits (release-level) and return a small set of validated track matches.
///
/// Discogs “images” are tied to releases; we validate by checking the release tracklist for an exact
/// normalized title match against `title`.
pub async fn search_tracks(
    state: &DiscogsState,
    client: &Client,
    artist: &str,
    title: &str,
    limit: usize,
    verbose_logs: bool,
) -> Vec<DiscogsTrackHit> {
    if !state.is_enabled() {
        return vec![];
    }

    let expected_title_norm = normalize_exact(title);
    if expected_title_norm.is_empty() {
        return vec![];
    }

    let _guard = state.gate.lock().await;

    let artist_q = urlencoding::encode(artist.trim());
    let title_q = urlencoding::encode(title.trim());
    if artist_q.is_empty() || title_q.is_empty() {
        return vec![];
    }

    // Query release candidates (we will validate via `/releases/{id}` tracklist).
    let per_page = (limit.max(1) * 5).min(25).max(3);
    let url = format!(
        "https://api.discogs.com/database/search?type=release&artist={}&track={}&per_page={}&page=1",
        artist_q, title_q, per_page
    );

    let Some(v) = get_json(state, client, &url).await else {
        return vec![];
    };
    let Some(results) = v.get("results").and_then(|x| x.as_array()) else {
        return vec![];
    };

    let mut release_ids: Vec<u64> = Vec::new();
    for r in results {
        if let Some(id) = r.get("id").and_then(|x| x.as_u64()) {
            release_ids.push(id);
        }
        if release_ids.len() >= limit.saturating_mul(6).max(6) {
            break;
        }
    }

    if release_ids.is_empty() {
        return vec![];
    }

    // Validate a subset of releases with `tracklist` checks.
    let max_release_checks = limit.saturating_mul(3).min(9).max(4);
    release_ids.truncate(max_release_checks);

    let mut out: Vec<DiscogsTrackHit> = Vec::new();
    let release_ids_len = release_ids.len();
    for release_id in release_ids {
        let release_url = format!("https://api.discogs.com/releases/{}", release_id);
        let Some(rel) = get_json(state, client, &release_url).await else {
            continue;
        };

        let release_title = rel
            .get("title")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let year = parse_u32_maybe(rel.get("year"));

        let matched_track_title = rel
            .get("tracklist")
            .and_then(|x| x.as_array())
            .and_then(|arr| {
                for item in arr {
                    let t_type = item
                        .get("type_")
                        .or_else(|| item.get("type"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("track");
                    // Prefer actual tracks; still accept if `type_` is missing.
                    if t_type != "track" && !t_type.is_empty() {
                        continue;
                    }
                    let t_title = item.get("title").and_then(|x| x.as_str()).unwrap_or("");
                    if t_title.is_empty() {
                        continue;
                    }
                    if normalize_exact(t_title) == expected_title_norm {
                        return Some(t_title.to_string());
                    }
                }
                None
            });
        let Some(matched_track_title) = matched_track_title else {
            continue;
        };

        let artist_name = rel
            .get("artists")
            .and_then(|x| x.as_array())
            .and_then(|arr| arr.first())
            .and_then(|x| x.get("name"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if artist_name.is_empty() {
            continue;
        }

        let cover_url = rel
            .get("images")
            .and_then(|x| x.as_array())
            .and_then(|arr| {
                let primary = arr.iter().find(|img| {
                    img.get("type").and_then(|t| t.as_str()).unwrap_or("") == "primary"
                });
                let chosen = primary.or_else(|| arr.first());
                chosen
                    .and_then(|img| img.get("uri").or_else(|| img.get("resource_url")))
                    .and_then(|u| u.as_str())
                    .map(|s| s.to_string())
            });

        out.push(DiscogsTrackHit {
            artist: artist_name,
            title: matched_track_title,
            album: release_title,
            year,
            cover_url,
        });

        if out.len() >= limit.max(1) {
            break;
        }
    }

    if verbose_logs && !out.is_empty() {
        eprintln!(
            "[discogs-track] a='{}' t='{}' candidates releases_checked={} hits={}",
            artist.trim(),
            title.trim(),
            release_ids_len,
            out.len()
        );
    }

    // Keep a small pause to avoid bursty traffic.
    tokio::time::sleep(Duration::from_millis(250)).await;

    out
}

