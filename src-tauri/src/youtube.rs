use std::time::Duration;

use regex::Regex;
use reqwest::Client;
use tokio::sync::Mutex;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) LibraryAutotag/0.1";

#[derive(Debug, Clone)]
pub struct YoutubeTrackHit {
    pub artist: String,
    pub title: String,
    pub cover_url: Option<String>,
}

pub struct YoutubeState {
    gate: Mutex<()>,
}

impl YoutubeState {
    pub fn new() -> Self {
        Self {
            gate: Mutex::new(()),
        }
    }
}

pub async fn search_tracks(
    state: &YoutubeState,
    client: &Client,
    artist: &str,
    title: &str,
    limit: usize,
    verbose_logs: bool,
) -> Vec<YoutubeTrackHit> {
    let _guard = state.gate.lock().await;
    let out = search_tracks_inner(client, artist, title, limit, verbose_logs).await;
    tokio::time::sleep(Duration::from_millis(220)).await;
    out
}

async fn search_tracks_inner(
    client: &Client,
    artist: &str,
    title: &str,
    limit: usize,
    verbose_logs: bool,
) -> Vec<YoutubeTrackHit> {
    let q = format!("{} {} topic", artist.trim(), title.trim())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if q.is_empty() {
        return vec![];
    }
    let url = format!(
        "https://www.youtube.com/results?search_query={}",
        urlencoding::encode(&q)
    );
    if verbose_logs {
        eprintln!("[youtube-search] query='{}' limit={}", q, limit);
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
    let Ok(html) = resp.text().await else {
        return vec![];
    };
    let video_re = Regex::new(
        r#""videoId":"([a-zA-Z0-9_-]{11})".+?"title":\{"runs":\[\{"text":"([^"]+)".+?"ownerText":\{"runs":\[\{"text":"([^"]+)""#,
    )
    .expect("youtube regex");
    let mut out: Vec<YoutubeTrackHit> = Vec::new();
    for caps in video_re.captures_iter(&html) {
        let Some(video_id) = caps.get(1).map(|m| m.as_str()) else {
            continue;
        };
        let Some(hit_title) = caps.get(2).map(|m| m.as_str().trim()) else {
            continue;
        };
        let Some(hit_artist) = caps.get(3).map(|m| m.as_str().trim()) else {
            continue;
        };
        if hit_title.is_empty() || hit_artist.is_empty() {
            continue;
        }
        if out
            .iter()
            .any(|h| h.title.eq_ignore_ascii_case(hit_title) && h.artist.eq_ignore_ascii_case(hit_artist))
        {
            continue;
        }
        out.push(YoutubeTrackHit {
            artist: hit_artist.to_string(),
            title: hit_title.to_string(),
            cover_url: Some(format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg")),
        });
        if out.len() >= limit.max(1) {
            break;
        }
    }
    if verbose_logs {
        eprintln!("[youtube-search] query='{}' returning={}", q, out.len());
    }
    out
}
