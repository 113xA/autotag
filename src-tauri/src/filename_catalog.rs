//! iTunes Search API: interpret filename stems into artist/title/art for lookup hints.

use std::time::Duration;

use reqwest::header::USER_AGENT;
use reqwest::Client;
use serde_json::Value;
use url::Url;

const UA: &str = "LibraryAutotag/0.1.0 (filename hints)";

/// Minimum overlap of stem tokens covered by artist+title for a "strong" local parse.
#[allow(dead_code)]
pub const LOCAL_STRONG_MIN: f64 = 0.42;
/// Minimum overlap for accepting an iTunes hit over weak locals.
#[allow(dead_code)]
pub const HINT_ACCEPT_MIN: f64 = 0.36;

#[derive(Debug, Clone)]
pub struct CatalogHit {
    pub artist: String,
    #[allow(dead_code)]
    pub title: String,
    /// iTunes `collectionName` when present (reserved for future bias).
    #[allow(dead_code)]
    pub album: Option<String>,
    #[allow(dead_code)]
    pub artwork_url_hires: Option<String>,
    pub score: f64,
}

fn norm_tokens(s: &str) -> Vec<String> {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .filter(|w| w.len() > 1)
        .map(String::from)
        .collect()
}

/// Share of stem tokens (length > 1) that appear as substrings in artist+title pool.
pub fn stem_overlap_score(stem: &str, artist: &str, title: &str) -> f64 {
    let stem_toks: Vec<String> = norm_tokens(stem);
    if stem_toks.is_empty() {
        return 0.0;
    }
    let pool = format!(
        "{} {}",
        norm_tokens(artist).join(" "),
        norm_tokens(title).join(" ")
    );
    let hit = stem_toks
        .iter()
        .filter(|t| pool.contains(t.as_str()))
        .count();
    hit as f64 / stem_toks.len() as f64
}

fn artwork_hires(url: &str) -> String {
    url.replace("100x100bb", "600x600bb")
        .replace("100x100", "600x600")
}

fn itunes_search_url(term: &str, limit: u32) -> Option<String> {
    let mut u = Url::parse("https://itunes.apple.com/search").ok()?;
    {
        let mut q = u.query_pairs_mut();
        q.append_pair("term", term);
        q.append_pair("entity", "song");
        q.append_pair("limit", &limit.to_string());
    }
    Some(u.to_string())
}

async fn itunes_search_rows(client: &Client, term: &str) -> Vec<(String, String, Option<String>, Option<String>)> {
    let Some(url) = itunes_search_url(term.trim(), 15) else {
        return vec![];
    };
    let resp = match client
        .get(&url)
        .header(USER_AGENT, UA)
        .timeout(Duration::from_secs(18))
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
    rows_from_itunes_json(&v)
}

fn rows_from_itunes_json(v: &Value) -> Vec<(String, String, Option<String>, Option<String>)> {
    let Some(arr) = v.get("results").and_then(|x| x.as_array()) else {
        return vec![];
    };
    let mut out = Vec::new();
    for r in arr {
        let Some(a) = r.get("artistName").and_then(|x| x.as_str()) else {
            continue;
        };
        let t = r
            .get("trackName")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        if t.is_empty() {
            continue;
        }
        let album = r
            .get("collectionName")
            .and_then(|x| x.as_str())
            .map(String::from);
        let art = r
            .get("artworkUrl100")
            .and_then(|x| x.as_str())
            .map(artwork_hires);
        out.push((a.to_string(), t, album, art));
    }
    out
}

fn collect_queries(stem: &str, local_artist: &str, local_title: &str) -> Vec<String> {
    let mut q: Vec<String> = Vec::new();
    let stem = stem.trim();
    if !stem.is_empty() {
        q.push(stem.to_string());
        let spaced = stem.replace('_', " ");
        if spaced != stem {
            q.push(spaced);
        }
    }
    let la = local_artist.trim();
    let lt = local_title.trim();
    if !la.is_empty() && !lt.is_empty() {
        q.push(format!("{la} {lt}"));
        q.push(format!("{lt} {la}"));
    } else if !lt.is_empty() {
        q.push(lt.to_string());
    } else if !la.is_empty() {
        q.push(la.to_string());
    }
    q.sort();
    q.dedup();
    q
}

/// Best iTunes hit scored against the filename stem.
pub async fn resolve_from_stem(
    client: &Client,
    stem: &str,
    local_artist: &str,
    local_title: &str,
) -> Option<CatalogHit> {
    let stem_trim = stem.trim();
    if stem_trim.is_empty() {
        return None;
    }

    let mut best: Option<(f64, CatalogHit)> = None;

    let queries = collect_queries(stem_trim, local_artist, local_title);
    let nq = queries.len();
    for (qi, term) in queries.into_iter().enumerate() {
        if term.len() < 2 {
            continue;
        }
        let rows = itunes_search_rows(client, &term).await;
        for (artist, title, album, art) in rows {
            let s = stem_overlap_score(stem_trim, &artist, &title);
            let hit = CatalogHit {
                artist,
                title,
                album,
                artwork_url_hires: art,
                score: s,
            };
            match &best {
                None => best = Some((s, hit)),
                Some((sb, _)) if s > *sb + 0.01 => best = Some((s, hit)),
                _ => {}
            }
        }
        if qi + 1 < nq {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    best.map(|(_, h)| h)
}

/// Choose artist/title strings for MusicBrainz lookup.
#[allow(dead_code)]
pub fn merge_for_mb(
    local_artist: &str,
    local_title: &str,
    stem: &str,
    hint: Option<&CatalogHit>,
) -> (String, String) {
    let la = local_artist.trim();
    let lt = local_title.trim();
    let local_score = stem_overlap_score(stem, la, lt);

    if local_score >= LOCAL_STRONG_MIN {
        return (la.to_string(), lt.to_string());
    }

    if let Some(h) = hint {
        if h.score >= HINT_ACCEPT_MIN {
            return (h.artist.clone(), h.title.clone());
        }
    }

    if la.is_empty() {
        if let Some(h) = hint {
            if h.score >= HINT_ACCEPT_MIN {
                return (h.artist.clone(), h.title.clone());
            }
        }
    }

    (la.to_string(), lt.to_string())
}

/// If the top MB candidate has no cover, use catalog artwork.
#[allow(dead_code)]
pub fn backfill_top_cover(candidates: &mut [crate::models::LookupCandidate], art: Option<&String>) {
    let Some(url) = art else {
        return;
    };
    if url.trim().is_empty() {
        return;
    }
    let Some(c) = candidates.first_mut() else {
        return;
    };
    let need = c
        .cover_url
        .as_ref()
        .map_or(true, |u| u.trim().is_empty());
    if need {
        c.cover_url = Some(url.clone());
        c.cover_options.push(crate::models::CoverOption {
            url: url.clone(),
            source: "itunes".to_string(),
            width: Some(600),
            height: Some(600),
            score: None,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlap_fisher_rain() {
        let s = stem_overlap_score(
            "FISHER Rain Extended Mix",
            "FISHER",
            "Rain",
        );
        assert!(s >= 0.5, "s={s}");
    }

    #[test]
    fn merge_prefers_strong_local() {
        let h = CatalogHit {
            artist: "Wrong".into(),
            title: "Song".into(),
            album: None,
            artwork_url_hires: None,
            score: 0.9,
        };
        let (a, t) = merge_for_mb("FISHER", "Rain", "FISHER Rain Extended", Some(&h));
        assert_eq!(a, "FISHER");
        assert_eq!(t, "Rain");
    }

    #[test]
    fn merge_uses_hint_when_local_weak() {
        let h = CatalogHit {
            artist: "FISHER".into(),
            title: "Losing It".into(),
            album: None,
            artwork_url_hires: Some("http://x/600.jpg".into()),
            score: 0.55,
        };
        let (a, t) = merge_for_mb("", "Love Rain Down", "FISHER Rain Mix", Some(&h));
        assert_eq!(a, "FISHER");
        assert_eq!(t, "Losing It");
    }

    #[test]
    fn parse_itunes_json_fixture() {
        let v: Value = serde_json::from_str(
            r#"{"resultCount":1,"results":[{"artistName":"FISHER","trackName":"Rain","collectionName":"EP","artworkUrl100":"https://is1-ssl.mzstatic.com/x/100x100bb.jpg"}]}"#,
        )
        .unwrap();
        let rows = rows_from_itunes_json(&v);
        assert_eq!(rows.len(), 1);
        let (a, t, al, art) = &rows[0];
        assert_eq!(a, "FISHER");
        assert_eq!(t, "Rain");
        assert_eq!(al.as_deref(), Some("EP"));
        assert!(art.as_ref().is_some_and(|u| u.contains("600x600")));
    }

    #[test]
    fn backfill_sets_cover_when_missing() {
        let mut c = vec![crate::models::LookupCandidate {
            recording_mbid: "".into(),
            release_mbid: "".into(),
            artist: "".into(),
            title: "".into(),
            album: "".into(),
            album_artist: None,
            track_number: None,
            year: None,
            cover_url: None,
            cover_options: vec![],
            score: None,
        }];
        backfill_top_cover(&mut c, Some(&"https://art/600.jpg".into()));
        assert_eq!(c[0].cover_url.as_deref(), Some("https://art/600.jpg"));
    }
}
