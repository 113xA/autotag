use std::time::{Duration, Instant};

use regex::Regex;
use reqwest::StatusCode;
use serde_json::Value;
use std::sync::OnceLock;
use tokio::sync::Mutex;

use crate::models::{CoverOption, LookupCandidate};
use crate::options::MatchingOptions;

const UA: &str = "LibraryAutotag/0.1.0 (https://example.com/autotag)";

pub struct MbState {
    pub(crate) client: reqwest::Client,
    last_request: Mutex<Option<Instant>>,
}

impl MbState {
    fn is_transient(status: StatusCode) -> bool {
        matches!(
            status,
            StatusCode::TOO_MANY_REQUESTS
                | StatusCode::SERVICE_UNAVAILABLE
                | StatusCode::BAD_GATEWAY
                | StatusCode::GATEWAY_TIMEOUT
        )
    }

    async fn get_with_retry(
        &self,
        req: reqwest::RequestBuilder,
    ) -> Result<Option<reqwest::Response>, String> {
        let mut backoff_ms = 600_u64;
        for attempt in 0..3 {
            let cloned = req
                .try_clone()
                .ok_or_else(|| "failed to clone MusicBrainz request".to_string())?;
            let resp = cloned.send().await.map_err(|e| e.to_string())?;
            if resp.status().is_success() {
                return Ok(Some(resp));
            }
            if Self::is_transient(resp.status()) {
                if attempt == 2 {
                    return Ok(None);
                }
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms * 2).min(3000);
                continue;
            }
            return Err(format!("MusicBrainz HTTP {}", resp.status()));
        }
        Ok(None)
    }

    pub fn new() -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .user_agent(UA)
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            client,
            last_request: Mutex::new(None),
        })
    }

    async fn throttle(&self) {
        let mut last = self.last_request.lock().await;
        let now = Instant::now();
        if let Some(prev) = *last {
            let elapsed = now.saturating_duration_since(prev);
            if elapsed < Duration::from_millis(1100) {
                let wait = Duration::from_millis(1100) - elapsed;
                drop(last);
                tokio::time::sleep(wait).await;
                last = self.last_request.lock().await;
            }
        }
        *last = Some(Instant::now());
    }

    pub async fn lookup(
        &self,
        artist: &str,
        title: &str,
        opts: &MatchingOptions,
    ) -> Result<Vec<LookupCandidate>, String> {
        let limit = opts.limit.clamp(1, 25) as u64;
        let primary = build_mb_query(artist, title, Some(opts));
        let mut arr = self
            .search_recordings_json(&primary, limit)
            .await?
            .unwrap_or_default();

        if arr.is_empty() && opts.fallback_recording_only {
            let q = build_mb_query(artist, title, None);
            arr = self
                .search_recordings_json(&q, limit)
                .await?
                .unwrap_or_default();
        }

        if arr.is_empty() && opts.fallback_strip_parens {
            let t2 = strip_paren_chunks(title);
            if t2 != title {
                let q = build_mb_query(artist, &t2, Some(opts));
                arr = self
                    .search_recordings_json(&q, limit)
                    .await?
                    .unwrap_or_default();
            }
            if arr.is_empty() && opts.fallback_recording_only {
                let q = build_mb_query(artist, &t2, None);
                arr = self
                    .search_recordings_json(&q, limit)
                    .await?
                    .unwrap_or_default();
            }
        }

        let mut out: Vec<LookupCandidate> = arr
            .iter()
            .filter_map(candidate_from_search_recording)
            .take(limit as usize)
            .collect();

        let need_enrich = out.is_empty()
            || out
                .iter()
                .all(|c| c.release_mbid.is_empty());
        if need_enrich {
            if let Some(id) = arr.first().and_then(|r| r.get("id")).and_then(|i| i.as_str()) {
                if let Some(enriched) = self.enrich_recording(id).await? {
                    if out.is_empty() {
                        out.push(enriched);
                    } else if let Some(first) = out.first_mut() {
                        *first = enriched;
                    }
                }
            }
        }

        Ok(out)
    }

    async fn search_recordings_json(
        &self,
        query: &str,
        limit: u64,
    ) -> Result<Option<Vec<Value>>, String> {
        self.throttle().await;
        let req = self
            .client
            .get("https://musicbrainz.org/ws/2/recording")
            .query(&[
                ("query", query),
                ("fmt", "json"),
                ("limit", &limit.to_string()),
            ]);
        let Some(resp) = self.get_with_retry(req).await? else {
            return Ok(None);
        };
        let v: Value = resp.json().await.map_err(|e| e.to_string())?;
        Ok(v.get("recordings")
            .and_then(|x| x.as_array())
            .cloned())
    }

    async fn enrich_recording(&self, recording_id: &str) -> Result<Option<LookupCandidate>, String> {
        self.throttle().await;
        let url = format!(
            "https://musicbrainz.org/ws/2/recording/{recording_id}?inc=releases+artist-credits&fmt=json"
        );
        let Some(resp) = self.get_with_retry(self.client.get(&url)).await? else {
            return Ok(None);
        };
        let v: Value = resp.json().await.map_err(|e| e.to_string())?;
        let rec = &v;
        let release = rec
            .get("releases")
            .and_then(|x| x.as_array())
            .and_then(|a| a.first());
        let Some(rel) = release else {
            return Ok(None);
        };
        Ok(Some(candidate_from_recording_and_release(rec, rel)))
    }
}

fn strip_paren_chunks(s: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"\([^)]*\)|\[[^\]]*\]").unwrap()
    });
    multispace_collapse(&re.replace_all(s, "").to_string())
}

fn multispace_collapse(s: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"\s+").unwrap());
    re.replace_all(s.trim(), " ").to_string()
}

fn build_mb_query(artist: &str, title: &str, with_bias: Option<&MatchingOptions>) -> String {
    let a = artist.trim();
    let t = title.trim();
    let mut q = if a.is_empty() {
        format!("recording:\"{}\"", escape_lucene(t))
    } else {
        format!(
            "artist:\"{}\" AND recording:\"{}\"",
            escape_lucene(a),
            escape_lucene(t)
        )
    };
    if let Some(opts) = with_bias {
        let bias = opts.tag_bias.trim();
        if !bias.is_empty() {
            q.push_str(" AND (");
            q.push_str(bias);
            q.push(')');
        }
    }
    q
}

fn escape_lucene(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('(', "\\(")
        .replace(')', "\\)")
}

fn artist_credit_name(rec: &Value) -> String {
    if let Some(n) = rec
        .get("artist-credit")
        .and_then(|ac| ac.get("name"))
        .and_then(|x| x.as_str())
    {
        return n.to_string();
    }
    rec.get("artist-credit")
        .and_then(|ac| ac.get("artist"))
        .and_then(|a| a.as_array())
        .map(|artists| {
            artists
                .iter()
                .filter_map(|x| x.get("name").and_then(|n| n.as_str()))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

fn candidate_from_search_recording(rec: &Value) -> Option<LookupCandidate> {
    rec.get("id")?.as_str()?;
    rec.get("title")?.as_str()?;
    let score = rec
        .get("score")
        .and_then(|s| s.as_i64())
        .map(|n| n as i32);

    let release = rec
        .get("releases")
        .and_then(|x| x.as_array())
        .and_then(|a| a.first())?;

    Some(candidate_from_recording_and_release(rec, release).with_score(score))
}

fn candidate_from_recording_and_release(rec: &Value, release: &Value) -> LookupCandidate {
    let recording_mbid = rec
        .get("id")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let title = rec
        .get("title")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let artist = artist_credit_name(rec);

    let release_mbid = release
        .get("id")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let album = release
        .get("title")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();

    let album_artist = release
        .get("artist-credit")
        .and_then(|ac| ac.get("name"))
        .and_then(|x| x.as_str())
        .map(String::from);

    let year = release.get("date").and_then(|v| {
        if let Some(s) = v.as_str() {
            s.get(0..4)?.parse::<u32>().ok()
        } else if let Some(n) = v.as_u64() {
            (1000..=9999).contains(&n).then_some(n as u32)
        } else {
            None
        }
    });

    let track_number: Option<u32> = None;

    let cover_url = if release_mbid.is_empty() {
        None
    } else {
        Some(format!(
            "https://coverartarchive.org/release/{release_mbid}/front-500"
        ))
    };

    LookupCandidate {
        recording_mbid,
        release_mbid,
        artist,
        title,
        album,
        album_artist,
        track_number,
        year,
        cover_url: cover_url.clone(),
        cover_options: cover_url
            .as_ref()
            .map(|url| {
                vec![CoverOption {
                    url: url.clone(),
                    source: "musicbrainz".to_string(),
                    width: Some(500),
                    height: Some(500),
                    score: None,
                }]
            })
            .unwrap_or_default(),
        score: None,
    }
}

trait WithScore {
    fn with_score(self, score: Option<i32>) -> Self;
}

impl WithScore for LookupCandidate {
    fn with_score(mut self, score: Option<i32>) -> Self {
        self.score = score;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_fixture_recording() {
        let rec = json!({
            "id": "rec1",
            "title": "Pressure Pleasure",
            "score": 95,
            "artist-credit": { "name": "Dimitri K & Lekkerfaces" },
            "releases": [{
                "id": "rel1",
                "title": "Some EP",
                "date": "2023-05-01",
                "artist-credit": { "name": "Various Artists" }
            }]
        });
        let c = candidate_from_search_recording(&rec).expect("candidate");
        assert_eq!(c.title, "Pressure Pleasure");
        assert_eq!(c.album, "Some EP");
        assert_eq!(c.year, Some(2023));
        assert!(c.cover_url.unwrap().contains("rel1"));
    }
}
