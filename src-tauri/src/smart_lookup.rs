use std::collections::{HashMap, HashSet};

use reqwest::Client;

use crate::amazon::{search_cover_urls as amazon_search_cover_urls, AmazonState};
use crate::deezer::{search_tracks as deezer_search_tracks, DeezerState};
use crate::filename_catalog::{resolve_from_stem, stem_overlap_score};
use crate::models::{CoverOption, LookupCandidate, LookupInput, LookupResult};
use crate::musicbrainz::MbState;
use crate::options::MatchingOptions;
use crate::spotify::{search_tracks as spotify_search_tracks, SpotifyState};

#[derive(Debug, Clone)]
struct ArtistGuess {
    artist: String,
    score: f64,
}

fn normalize_artist_key(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn split_artist_tokens(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for token in s.split(',').map(|x| x.trim()).filter(|x| !x.is_empty()) {
        let key = normalize_artist_key(token);
        if key.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        out.push(token.to_string());
    }
    out
}

fn normalize_artist_display(s: &str) -> String {
    let replaced = s
        .replace(" feat. ", ", ")
        .replace(" feat ", ", ")
        .replace(" ft. ", ", ")
        .replace(" ft ", ", ")
        .replace(" & ", ", ")
        .replace(" x ", ", ")
        .replace(';', ",");
    let tokens = split_artist_tokens(&replaced);
    if tokens.is_empty() {
        s.trim().to_string()
    } else {
        tokens.join(", ")
    }
}

fn infer_artist_title(artist_in: &str, title_in: &str, stem_in: &str) -> (String, String) {
    let artist = artist_in.trim();
    let title = title_in.trim();
    let suspicious_artist =
        artist.contains(" — ") || artist.contains(" – ") || artist.contains(" - ");
    let suspicious_title = {
        let tt = title.to_lowercase();
        tt.contains(".info")
            || tt.contains(".com")
            || tt.contains("themp3")
            || tt.contains("4djsonline")
            || tt.contains("download")
    };
    if !artist.is_empty() && !title.is_empty() && !suspicious_artist && !suspicious_title {
        return (normalize_artist_display(artist), title.to_string());
    }
    let source = if !stem_in.trim().is_empty() {
        stem_in.trim()
    } else {
        title
    };
    for sep in [" - ", " — ", " – "] {
        if let Some((a, t)) = source.split_once(sep) {
            let aa = a.trim();
            let tt = t.trim();
            if !aa.is_empty() && !tt.is_empty() {
                return (normalize_artist_display(aa), tt.to_string());
            }
        }
    }
    (
        normalize_artist_display(artist),
        if title.is_empty() {
            source.to_string()
        } else {
            title.to_string()
        },
    )
}

fn title_residual(stem: &str, artist: &str) -> String {
    let mut out = stem.to_string();
    for tok in artist.split_whitespace() {
        if tok.len() <= 1 {
            continue;
        }
        out = out.replace(tok, " ");
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn confidence_for(candidates: &[LookupCandidate], stem: &str) -> (String, Vec<f64>) {
    let mut scores = candidates
        .iter()
        .map(|c| stem_overlap_score(stem, &c.artist, &c.title))
        .collect::<Vec<_>>();
    scores.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    let top = scores.first().copied().unwrap_or(0.0);
    let second = scores.get(1).copied().unwrap_or(0.0);
    let gap = top - second;
    let level = if top >= 0.85 && gap >= 0.15 {
        "high"
    } else if top >= 0.55 {
        "medium"
    } else {
        "low"
    };
    (level.to_string(), scores)
}

#[derive(Debug, Clone)]
struct RawCover {
    url: String,
    source: &'static str,
    width: Option<u32>,
    height: Option<u32>,
    artist: Option<String>,
    title: Option<String>,
}

fn cover_quality_score(width: Option<u32>, height: Option<u32>) -> f64 {
    let px = width.unwrap_or(0) as f64 * height.unwrap_or(0) as f64;
    if px >= 1000.0 * 1000.0 {
        1.0
    } else if px >= 500.0 * 500.0 {
        0.85
    } else if px > 0.0 {
        0.65
    } else {
        0.40
    }
}

fn source_weight(source: &str) -> f64 {
    match source {
        "musicbrainz" => 0.60,
        "spotify" => 0.92,
        "deezer" => 0.86,
        "amazon" => 0.70,
        _ => 0.60,
    }
}

fn normalize_url_key(url: &str) -> String {
    let lower = url.to_lowercase();
    let base = lower.split('?').next().unwrap_or(&lower).to_string();
    base.replace("%2b", "+")
}

fn rank_cover_for_candidate(c: &LookupCandidate, raw: &RawCover) -> f64 {
    let source = source_weight(raw.source);
    let quality = cover_quality_score(raw.width, raw.height);
    let sim = match (raw.artist.as_deref(), raw.title.as_deref()) {
        (Some(a), Some(t)) => stem_overlap_score(&format!("{} - {}", c.artist, c.title), a, t),
        _ => 0.5,
    };
    source * 0.45 + quality * 0.25 + sim * 0.30
}

fn add_cover_from_candidate(pool: &mut Vec<RawCover>, c: &LookupCandidate, source: &'static str) {
    if let Some(url) = c.cover_url.as_ref() {
        pool.push(RawCover {
            url: url.clone(),
            source,
            width: c
                .cover_options
                .iter()
                .find(|co| co.url == *url)
                .and_then(|co| co.width),
            height: c
                .cover_options
                .iter()
                .find(|co| co.url == *url)
                .and_then(|co| co.height),
            artist: Some(c.artist.clone()),
            title: Some(c.title.clone()),
        });
    }
    for co in &c.cover_options {
        pool.push(RawCover {
            url: co.url.clone(),
            source,
            width: co.width,
            height: co.height,
            artist: Some(c.artist.clone()),
            title: Some(c.title.clone()),
        });
    }
}

fn attach_best_cover_options(cands: &mut [LookupCandidate], pool: &[RawCover]) {
    for c in cands {
        let mut ranked = pool
            .iter()
            .map(|raw| {
                let score = rank_cover_for_candidate(c, raw);
                (raw, score)
            })
            .collect::<Vec<_>>();
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        let mut seen = HashSet::new();
        let mut out = Vec::<CoverOption>::new();
        for (raw, score) in ranked {
            let key = normalize_url_key(&raw.url);
            if seen.contains(&key) {
                continue;
            }
            seen.insert(key);
            out.push(CoverOption {
                url: raw.url.clone(),
                source: raw.source.to_string(),
                width: raw.width,
                height: raw.height,
                score: Some(score),
            });
            if out.len() >= 4 {
                break;
            }
        }
        if c.cover_url.is_none() {
            c.cover_url = out.first().map(|o| o.url.clone());
        }
        c.cover_options = out;
    }
}

fn dedupe_and_sort(mut cands: Vec<LookupCandidate>, stem: &str) -> Vec<LookupCandidate> {
    let mut seen = HashSet::new();
    cands.retain(|c| {
        let k = format!(
            "{}|{}",
            normalize_artist_key(&c.artist),
            c.title.to_lowercase()
        );
        if seen.contains(&k) {
            false
        } else {
            seen.insert(k);
            true
        }
    });
    cands.sort_by(|a, b| {
        let sa = stem_overlap_score(stem, &a.artist, &a.title);
        let sb = stem_overlap_score(stem, &b.artist, &b.title);
        sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
    });
    cands
}

async fn identify_artists(
    client: &Client,
    deezer: &DeezerState,
    spotify: &SpotifyState,
    item: &LookupInput,
    matching: &MatchingOptions,
) -> Vec<String> {
    let stem = item.filename_stem.trim();
    let mut map: HashMap<String, ArtistGuess> = HashMap::new();
    let local_artist = item.artist.trim().to_string();
    if !local_artist.is_empty() {
        let s = stem_overlap_score(stem, &local_artist, &item.title);
        map.insert(
            normalize_artist_key(&local_artist),
            ArtistGuess {
                artist: local_artist.clone(),
                score: s.max(0.30),
            },
        );
        for tok in split_artist_tokens(&local_artist) {
            let ts = stem_overlap_score(stem, &tok, &item.title);
            map.entry(normalize_artist_key(&tok))
                .and_modify(|g| g.score = g.score.max(ts.max(0.25)))
                .or_insert(ArtistGuess {
                    artist: tok,
                    score: ts.max(0.25),
                });
        }
    }
    if let Some((a, _)) = stem.split_once(" - ") {
        let aa = a.trim();
        if !aa.is_empty() {
            let s = stem_overlap_score(stem, aa, &item.title);
            map.entry(normalize_artist_key(aa)).or_insert(ArtistGuess {
                artist: aa.to_string(),
                score: s.max(0.25),
            });
        }
    }
    if matching.use_itunes_filename_hints {
        if let Some(h) = resolve_from_stem(client, stem, &item.artist, &item.title).await {
            map.entry(normalize_artist_key(&h.artist))
                .and_modify(|g| g.score = g.score.max(h.score))
                .or_insert(ArtistGuess {
                    artist: h.artist,
                    score: h.score,
                });
        }
    }
    if matching.use_deezer {
        let hits = deezer_search_tracks(deezer, client, stem, 8).await;
        for h in hits {
            let s = stem_overlap_score(stem, &h.artist, &h.title);
            map.entry(normalize_artist_key(&h.artist))
                .and_modify(|g| g.score = g.score.max(s))
                .or_insert(ArtistGuess {
                    artist: normalize_artist_display(&h.artist),
                    score: s,
                });
        }
    }
    if matching.use_spotify {
        let hits = spotify_search_tracks(spotify, client, stem, 8).await;
        for h in hits {
            let s = stem_overlap_score(stem, &h.artist, &h.title);
            map.entry(normalize_artist_key(&h.artist))
                .and_modify(|g| g.score = g.score.max(s))
                .or_insert(ArtistGuess {
                    artist: normalize_artist_display(&h.artist),
                    score: s,
                });
        }
    }
    let mut guesses = map.into_values().collect::<Vec<_>>();
    guesses.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    guesses.into_iter().take(5).map(|g| g.artist).collect()
}

fn candidate_from_deezer(
    artist: String,
    title: String,
    album: Option<String>,
    cover_url: Option<String>,
    year: Option<u32>,
) -> LookupCandidate {
    let cover_options = cover_url
        .as_ref()
        .map(|url| {
            vec![CoverOption {
                url: url.clone(),
                source: "deezer".to_string(),
                width: Some(1200),
                height: Some(1200),
                score: None,
            }]
        })
        .unwrap_or_default();
    LookupCandidate {
        recording_mbid: String::new(),
        release_mbid: String::new(),
        artist: normalize_artist_display(&artist),
        title,
        album: album.unwrap_or_default(),
        album_artist: None,
        track_number: None,
        year,
        cover_url,
        cover_options,
        score: None,
    }
}

fn candidate_from_spotify(
    artist: String,
    title: String,
    album: Option<String>,
    cover_url: Option<String>,
    year: Option<u32>,
) -> LookupCandidate {
    let cover_options = cover_url
        .as_ref()
        .map(|url| {
            vec![CoverOption {
                url: url.clone(),
                source: "spotify".to_string(),
                width: Some(640),
                height: Some(640),
                score: None,
            }]
        })
        .unwrap_or_default();
    LookupCandidate {
        recording_mbid: String::new(),
        release_mbid: String::new(),
        artist: normalize_artist_display(&artist),
        title,
        album: album.unwrap_or_default(),
        album_artist: None,
        track_number: None,
        year,
        cover_url,
        cover_options,
        score: None,
    }
}

pub async fn smart_lookup_one(
    _state: &MbState,
    client: &Client,
    deezer: &DeezerState,
    spotify: &SpotifyState,
    amazon: &AmazonState,
    item: &LookupInput,
    matching: &MatchingOptions,
) -> Result<LookupResult, String> {
    let stem = item.filename_stem.trim();
    let (seed_artist, seed_title) = infer_artist_title(&item.artist, &item.title, stem);
    let seed_artist_for_queries = if seed_artist.is_empty() {
        item.artist.as_str()
    } else {
        seed_artist.as_str()
    };
    let seed_title_for_queries = if seed_title.is_empty() {
        item.title.as_str()
    } else {
        seed_title.as_str()
    };
    let artists = identify_artists(
        client,
        deezer,
        spotify,
        &LookupInput {
            path: item.path.clone(),
            artist: seed_artist_for_queries.to_string(),
            title: seed_title_for_queries.to_string(),
            filename_stem: item.filename_stem.clone(),
        },
        matching,
    )
    .await;
    let mut merged: Vec<LookupCandidate> = Vec::new();
    let mut cover_pool: Vec<RawCover> = Vec::new();

    let mut searched_any = false;
    for a in artists.iter().take(3) {
        let residual = title_residual(stem, a);
        let query_title = if residual.trim().is_empty() {
            item.title.trim()
        } else {
            residual.trim()
        };
        if matching.use_deezer {
            let q = format!("{a} {query_title}");
            let dz = deezer_search_tracks(deezer, client, &q, matching.limit as usize).await;
            if !dz.is_empty() {
                searched_any = true;
            }
            for h in dz {
                if let Some(url) = h.cover_url.clone() {
                    cover_pool.push(RawCover {
                        url,
                        source: "deezer",
                        width: Some(1200),
                        height: Some(1200),
                        artist: Some(h.artist.clone()),
                        title: Some(h.title.clone()),
                    });
                }
                merged.push(candidate_from_deezer(h.artist, h.title, h.album, h.cover_url, h.year));
            }
        }
        if matching.use_spotify {
            let q = format!("{a} {query_title}");
            let sp = spotify_search_tracks(spotify, client, &q, matching.limit as usize).await;
            if !sp.is_empty() {
                searched_any = true;
            }
            for h in sp {
                if let Some(url) = h.cover_url.clone() {
                    cover_pool.push(RawCover {
                        url,
                        source: "spotify",
                        width: Some(640),
                        height: Some(640),
                        artist: Some(h.artist.clone()),
                        title: Some(h.title.clone()),
                    });
                }
                merged.push(candidate_from_spotify(h.artist, h.title, h.album, h.cover_url, h.year));
            }
        }
        if matching.use_amazon {
            for hit in amazon_search_cover_urls(amazon, client, a, query_title, 6).await {
                searched_any = true;
                cover_pool.push(RawCover {
                    url: hit.url,
                    source: "amazon",
                    width: None,
                    height: None,
                    artist: Some(a.clone()),
                    title: Some(query_title.to_string()),
                });
            }
        }
    }

    if !searched_any {
        if matching.use_deezer {
            let q = format!("{} {}", seed_artist_for_queries.trim(), seed_title_for_queries.trim());
            let dz = deezer_search_tracks(deezer, client, &q, matching.limit as usize).await;
            for h in dz {
                if let Some(url) = h.cover_url.clone() {
                    cover_pool.push(RawCover {
                        url,
                        source: "deezer",
                        width: Some(1200),
                        height: Some(1200),
                        artist: Some(h.artist.clone()),
                        title: Some(h.title.clone()),
                    });
                }
                merged.push(candidate_from_deezer(h.artist, h.title, h.album, h.cover_url, h.year));
            }
        }
        if matching.use_spotify {
            let q = format!("{} {}", seed_artist_for_queries.trim(), seed_title_for_queries.trim());
            let sp = spotify_search_tracks(spotify, client, &q, matching.limit as usize).await;
            for h in sp {
                if let Some(url) = h.cover_url.clone() {
                    cover_pool.push(RawCover {
                        url,
                        source: "spotify",
                        width: Some(640),
                        height: Some(640),
                        artist: Some(h.artist.clone()),
                        title: Some(h.title.clone()),
                    });
                }
                merged.push(candidate_from_spotify(h.artist, h.title, h.album, h.cover_url, h.year));
            }
        }
        for hit in amazon_search_cover_urls(
            amazon,
            client,
            seed_artist_for_queries,
            seed_title_for_queries,
            6,
        )
        .await
        {
            cover_pool.push(RawCover {
                url: hit.url,
                source: "amazon",
                width: None,
                height: None,
                artist: Some(seed_artist_for_queries.to_string()),
                title: Some(seed_title_for_queries.to_string()),
            });
        }
    }

    if merged.is_empty() {
        merged.push(LookupCandidate {
            recording_mbid: String::new(),
            release_mbid: String::new(),
            artist: seed_artist,
            title: seed_title,
            album: String::new(),
            album_artist: None,
            track_number: None,
            year: None,
            cover_url: None,
            cover_options: vec![],
            score: None,
        });
    }

    let mut candidates = dedupe_and_sort(merged, stem);
    attach_best_cover_options(&mut candidates, &cover_pool);
    let (confidence, _) = confidence_for(&candidates, stem);
    Ok(LookupResult {
        path: item.path.clone(),
        candidates,
        confidence,
        artist_guesses: artists,
    })
}

pub async fn musicbrainz_only_lookup_one(
    state: &MbState,
    item: &LookupInput,
    matching: &MatchingOptions,
) -> Result<LookupResult, String> {
    let stem = item.filename_stem.trim();
    let mut candidates = state.lookup(&item.artist, &item.title, matching).await?;
    for c in &mut candidates {
        c.artist = normalize_artist_display(&c.artist);
    }
    let candidates = dedupe_and_sort(candidates, stem);
    let (confidence, _) = confidence_for(&candidates, stem);
    Ok(LookupResult {
        path: item.path.clone(),
        candidates,
        confidence,
        artist_guesses: split_artist_tokens(&item.artist),
    })
}
