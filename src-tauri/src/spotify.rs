use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

use base64::Engine;
use reqwest::Client;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use url::Url;

#[derive(Debug, Clone)]
pub struct SpotifyTrackHit {
    pub artist: String,
    pub title: String,
    pub album: Option<String>,
    pub cover_url: Option<String>,
    pub year: Option<u32>,
}

#[derive(Debug, Clone, Default)]
pub struct SpotifyToken {
    pub access_token: String,
    pub expires_at: Option<Instant>,
}

pub struct SpotifyState {
    pub token: Mutex<SpotifyToken>,
}

impl SpotifyState {
    pub fn new() -> Self {
        Self {
            token: Mutex::new(SpotifyToken::default()),
        }
    }
}

fn random_token(len: usize) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut out = String::with_capacity(len);
    for _ in 0..len {
        let idx = (rand::random::<u8>() as usize) % ALPHABET.len();
        out.push(ALPHABET[idx] as char);
    }
    out
}

fn code_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

fn parse_query_value(url: &str, key: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    for (k, v) in parsed.query_pairs() {
        if k == key {
            return Some(v.to_string());
        }
    }
    None
}

fn wait_for_auth_redirect(port: u16, expected_state: &str) -> Result<String, String> {
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    listener
        .set_nonblocking(false)
        .map_err(|e| e.to_string())?;
    let (mut stream, _) = listener.accept().map_err(|e| e.to_string())?;
    let mut req_buf = [0_u8; 4096];
    let n = stream.read(&mut req_buf).map_err(|e| e.to_string())?;
    let req = String::from_utf8_lossy(&req_buf[..n]).to_string();
    let first = req.lines().next().unwrap_or("");
    let path = first
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| "invalid redirect request".to_string())?;
    let full = format!("http://127.0.0.1:{port}{path}");
    let state = parse_query_value(&full, "state").unwrap_or_default();
    let code = parse_query_value(&full, "code").unwrap_or_default();
    let error = parse_query_value(&full, "error").unwrap_or_default();
    let (status, body) = if !error.is_empty() {
        (
            "400 Bad Request",
            "<h2>Spotify login failed</h2><p>You can close this tab.</p>",
        )
    } else if state != expected_state || code.is_empty() {
        (
            "400 Bad Request",
            "<h2>Invalid Spotify callback</h2><p>You can close this tab.</p>",
        )
    } else {
        (
            "200 OK",
            "<h2>Spotify connected</h2><p>You can close this tab and return to the app.</p>",
        )
    };
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(resp.as_bytes());
    if !error.is_empty() {
        return Err(format!("Spotify login canceled: {error}"));
    }
    if state != expected_state {
        return Err("Spotify callback state mismatch".into());
    }
    if code.is_empty() {
        return Err("Spotify callback did not include auth code".into());
    }
    Ok(code)
}

pub async fn auth_browser_pkce(
    state: &SpotifyState,
    client: &Client,
    client_id: &str,
) -> Result<u64, String> {
    let cid = client_id.trim();
    if cid.is_empty() {
        return Err("Spotify client ID required".into());
    }
    let port = 43857_u16;
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let verifier = random_token(72);
    let challenge = code_challenge(&verifier);
    let oauth_state = random_token(24);
    let auth_url = format!(
        "https://accounts.spotify.com/authorize?response_type=code&client_id={}&redirect_uri={}&code_challenge_method=S256&code_challenge={}&state={}",
        urlencoding::encode(cid),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(&challenge),
        urlencoding::encode(&oauth_state),
    );
    webbrowser::open(&auth_url).map_err(|e| format!("Could not open browser: {e}"))?;

    let expected_state = oauth_state.clone();
    let code = tokio::time::timeout(
        Duration::from_secs(120),
        tokio::task::spawn_blocking(move || wait_for_auth_redirect(port, &expected_state)),
    )
    .await
    .map_err(|_| "Spotify login timed out".to_string())?
    .map_err(|e| e.to_string())??;

    let resp = client
        .post("https://accounts.spotify.com/api/token")
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("client_id", cid),
            ("code_verifier", verifier.as_str()),
        ])
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Spotify auth HTTP {}", resp.status()));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let token = v
        .get("access_token")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let expires_in = v.get("expires_in").and_then(|x| x.as_u64()).unwrap_or(3600);
    if token.trim().is_empty() {
        return Err("Spotify auth returned empty token".into());
    }
    let mut guard = state.token.lock().await;
    guard.access_token = token;
    guard.expires_at = Some(Instant::now() + Duration::from_secs(expires_in.saturating_sub(30)));
    Ok(expires_in)
}

pub async fn auth_client_credentials(
    state: &SpotifyState,
    client: &Client,
    client_id: &str,
    client_secret: &str,
) -> Result<u64, String> {
    let cid = client_id.trim();
    let sec = client_secret.trim();
    if cid.is_empty() || sec.is_empty() {
        return Err("Spotify client ID/secret required".into());
    }
    let raw = format!("{cid}:{sec}");
    let encoded = base64::engine::general_purpose::STANDARD.encode(raw.as_bytes());
    let resp = client
        .post("https://accounts.spotify.com/api/token")
        .header(reqwest::header::AUTHORIZATION, format!("Basic {encoded}"))
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body("grant_type=client_credentials")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Spotify auth HTTP {}", resp.status()));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let token = v
        .get("access_token")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let expires_in = v.get("expires_in").and_then(|x| x.as_u64()).unwrap_or(3600);
    if token.trim().is_empty() {
        return Err("Spotify auth returned empty token".into());
    }
    let mut guard = state.token.lock().await;
    guard.access_token = token;
    guard.expires_at = Some(Instant::now() + Duration::from_secs(expires_in.saturating_sub(30)));
    Ok(expires_in)
}

pub async fn current_token(state: &SpotifyState) -> Option<String> {
    let guard = state.token.lock().await;
    let ok = guard
        .expires_at
        .map(|t| t > Instant::now())
        .unwrap_or(false);
    if ok && !guard.access_token.is_empty() {
        Some(guard.access_token.clone())
    } else {
        None
    }
}

pub async fn search_tracks(
    state: &SpotifyState,
    client: &Client,
    query: &str,
    limit: usize,
) -> Vec<SpotifyTrackHit> {
    let q = query.trim();
    if q.is_empty() {
        return vec![];
    }
    let Some(token) = current_token(state).await else {
        return vec![];
    };
    let url = format!(
        "https://api.spotify.com/v1/search?q={}&type=track&limit={}",
        urlencoding::encode(q),
        limit.max(1).min(15)
    );
    let resp = match client
        .get(url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
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
    let Some(rows) = v
        .get("tracks")
        .and_then(|x| x.get("items"))
        .and_then(|x| x.as_array())
    else {
        return vec![];
    };
    rows.iter()
        .filter_map(|r| {
            let title = r.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let artist = r
                .get("artists")
                .and_then(|x| x.as_array())
                .and_then(|a| a.first())
                .and_then(|x| x.get("name"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            if artist.trim().is_empty() || title.trim().is_empty() {
                return None;
            }
            let album = r
                .get("album")
                .and_then(|x| x.get("name"))
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
            let cover_url = r
                .get("album")
                .and_then(|x| x.get("images"))
                .and_then(|x| x.as_array())
                .and_then(|arr| arr.first())
                .and_then(|x| x.get("url"))
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
            let year = r
                .get("album")
                .and_then(|x| x.get("release_date"))
                .and_then(|x| x.as_str())
                .and_then(|s| s.get(0..4))
                .and_then(|y| y.parse::<u32>().ok());
            Some(SpotifyTrackHit {
                artist,
                title,
                album,
                cover_url,
                year,
            })
        })
        .collect()
}
