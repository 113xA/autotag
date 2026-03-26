use std::time::Duration;

use regex::Regex;
use reqwest::Client;
use std::sync::OnceLock;
use tokio::sync::Mutex;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) LibraryAutotag/0.1";

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
    tokio::time::sleep(Duration::from_millis(900)).await;
    out
}

async fn search_cover_urls_inner(
    client: &Client,
    artist: &str,
    title: &str,
    limit: usize,
) -> Vec<AmazonCoverHit> {
    let q = format!("{} {} cd", artist.trim(), title.trim()).trim().to_string();
    if q.is_empty() {
        return vec![];
    }
    let url = format!(
        "https://www.amazon.com/s?k={}&i=popular",
        urlencoding::encode(&q)
    );
    let resp = match client
        .get(url)
        .header(reqwest::header::USER_AGENT, UA)
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9")
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
    let mut out = Vec::new();
    for url in extract_amazon_image_urls(&html).into_iter().take(limit.max(1)) {
        out.push(AmazonCoverHit { url });
    }
    out
}

fn extract_amazon_image_urls(html: &str) -> Vec<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r#"https://m\.media-amazon\.com/images/I/[A-Za-z0-9%._+-]+\.(jpg|jpeg|png)"#)
            .expect("amazon image regex")
    });
    let mut out = Vec::new();
    for m in re.find_iter(html) {
        let url = m.as_str().replace("%2B", "+");
        if !out.iter().any(|u| u == &url) {
            out.push(url);
        }
    }
    out
}
