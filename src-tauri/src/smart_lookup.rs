use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use reqwest::Client;
use regex::Regex;
use std::sync::OnceLock;

use crate::amazon::{
    search_cover_urls as itunes_search_cover_urls, search_tracks as itunes_search_tracks,
    AmazonState, ItunesTrackHit,
};
use crate::deezer::{search_tracks as deezer_search_tracks, DeezerState};
use crate::filename_catalog::{resolve_from_stem, stem_overlap_score};
use crate::models::{CoverOption, LookupCandidate, LookupInput, LookupResult};
use crate::musicbrainz::MbState;
use crate::options::MatchingOptions;
use crate::spotify::{search_tracks as spotify_search_tracks, SpotifyState};
use crate::youtube::{search_tracks as youtube_search_tracks, YoutubeState};

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

fn trailing_mix_keyword_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:\s*(?:[-–—]\s*)?[\(\[]?\s*(?:extended mix|extended version|extended edit|extended|original mix|original version|club mix|dub mix|radio edit|radio mix|instrumental|bootleg|mashup|vip|remix|edit|version|mix)\s*[\)\]]?)\s*$",
        )
        .unwrap()
    })
}

fn strip_title_mix_keywords(title: &str) -> String {
    let re = trailing_mix_keyword_re();
    let mut out = title.trim().to_string();
    for _ in 0..8 {
        let next = re.replace_all(out.trim_end(), "").to_string();
        let next = next.trim_end().to_string();
        if next == out {
            break;
        }
        out = next;
    }
    out.trim().to_string()
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
        return (
            normalize_artist_display(artist),
            strip_title_mix_keywords(title),
        );
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
                return (normalize_artist_display(aa), strip_title_mix_keywords(tt));
            }
        }
    }
    (
        normalize_artist_display(artist),
        if title.is_empty() {
            strip_title_mix_keywords(source)
        } else {
            strip_title_mix_keywords(title)
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
        "deezer" => 0.92,
        "itunes" => 0.88,
        "youtube" => 0.70,
        "spotify" => 0.66,
        "amazon" => 0.70,
        _ => 0.60,
    }
}

fn candidate_source_weight(c: &LookupCandidate) -> f64 {
    if c.cover_options.iter().any(|o| o.source == "deezer") {
        1.0
    } else if c.cover_options.iter().any(|o| o.source == "itunes") {
        0.92
    } else if c.cover_options.iter().any(|o| o.source == "youtube") {
        0.80
    } else if c.cover_options.iter().any(|o| o.source == "spotify") {
        0.72
    } else {
        0.70
    }
}

fn normalize_url_key(url: &str) -> String {
    let lower = url.to_lowercase();
    let base = lower.split('?').next().unwrap_or(&lower).to_string();
    base.replace("%2b", "+")
}

fn push_raw_cover(pool: &mut Vec<RawCover>, seen: &mut HashSet<String>, raw: RawCover) {
    let key = format!("{}|{}", raw.source, normalize_url_key(&raw.url));
    if seen.contains(&key) {
        return;
    }
    seen.insert(key);
    pool.push(raw);
}

fn build_query_variants(artist: &str, title: &str, stem: &str, residual: &str) -> Vec<String> {
    let mut out = Vec::<String>::new();
    let mut seen = HashSet::<String>::new();
    let candidates = [
        format!("{artist} {title}"),
        format!("{artist} - {title}"),
        format!("{artist} {residual}"),
        format!("{artist} {stem}"),
        title.to_string(),
        residual.to_string(),
    ];
    for q in candidates {
        let qq = q.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_string();
        if qq.is_empty() {
            continue;
        }
        let key = qq.to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        out.push(qq);
    }
    out
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

#[allow(dead_code)]
fn add_cover_from_candidate(
    pool: &mut Vec<RawCover>,
    c: &LookupCandidate,
    source: &'static str,
) {
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

fn title_noise_penalty(title: &str) -> f64 {
    let t = title.to_lowercase();
    if t.contains(".info") || t.contains("download") || t.contains("jsonline") {
        0.25
    } else if t.contains("extended") || t.contains("original mix") || t.contains("remix") {
        0.08
    } else {
        0.0
    }
}

fn candidate_relevance_score(stem: &str, c: &LookupCandidate) -> f64 {
    let overlap = stem_overlap_score(stem, &c.artist, &c.title);
    let source = candidate_source_weight(c);
    let noise = title_noise_penalty(&c.title);
    (overlap * 0.78 + source * 0.22 - noise).max(0.0)
}

fn apply_dynamic_relevance_filter(mut cands: Vec<LookupCandidate>, stem: &str) -> Vec<LookupCandidate> {
    if cands.len() <= 1 {
        return cands;
    }
    let mut scored = cands
        .drain(..)
        .map(|c| {
            let s = candidate_relevance_score(stem, &c);
            (c, s)
        })
        .collect::<Vec<_>>();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let top = scored.first().map(|x| x.1).unwrap_or(0.0);
    let second = scored.get(1).map(|x| x.1).unwrap_or(0.0);
    let strict = top >= 0.74 && (top - second) >= 0.12;
    let min = if strict {
        (top - 0.10).max(0.64)
    } else if top >= 0.55 {
        (top - 0.22).max(0.42)
    } else {
        0.30
    };
    let keep = if strict { 4 } else { 8 };
    let mut out = scored
        .into_iter()
        .filter(|(_, s)| *s >= min)
        .take(keep)
        .map(|(c, _)| c)
        .collect::<Vec<_>>();
    if out.is_empty() {
        out = vec![];
    }
    out
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
        let sa = candidate_relevance_score(stem, a);
        let sb = candidate_relevance_score(stem, b);
        sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
    });
    apply_dynamic_relevance_filter(cands, stem)
}

async fn identify_artists(
    client: &Client,
    deezer: &DeezerState,
    spotify: &SpotifyState,
    amazon: &AmazonState,
    youtube: &YoutubeState,
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
    if matching.use_amazon {
        let hits = itunes_search_tracks(amazon, client, &item.artist, &item.title, 8, false).await;
        for h in hits {
            let s = stem_overlap_score(stem, &h.artist, &h.title);
            map.entry(normalize_artist_key(&h.artist))
                .and_modify(|g| g.score = g.score.max((s * 0.95).max(0.30)))
                .or_insert(ArtistGuess {
                    artist: normalize_artist_display(&h.artist),
                    score: (s * 0.95).max(0.30),
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
    if matching.use_youtube {
        let hits = youtube_search_tracks(youtube, client, &item.artist, &item.title, 6, false).await;
        for h in hits {
            let s = stem_overlap_score(stem, &h.artist, &h.title);
            map.entry(normalize_artist_key(&h.artist))
                .and_modify(|g| g.score = g.score.max((s * 0.75).max(0.22)))
                .or_insert(ArtistGuess {
                    artist: normalize_artist_display(&h.artist),
                    score: (s * 0.75).max(0.22),
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
        title: strip_title_mix_keywords(&title),
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
        title: strip_title_mix_keywords(&title),
        album: album.unwrap_or_default(),
        album_artist: None,
        track_number: None,
        year,
        cover_url,
        cover_options,
        score: None,
    }
}

fn candidate_from_itunes(h: ItunesTrackHit) -> LookupCandidate {
    let cover_options = h
        .cover_url
        .as_ref()
        .map(|url| {
            vec![CoverOption {
                url: url.clone(),
                source: "itunes".to_string(),
                width: Some(1200),
                height: Some(1200),
                score: None,
            }]
        })
        .unwrap_or_default();
    LookupCandidate {
        recording_mbid: String::new(),
        release_mbid: String::new(),
        artist: normalize_artist_display(&h.artist),
        title: strip_title_mix_keywords(&h.title),
        album: h.album.unwrap_or_default(),
        album_artist: None,
        track_number: None,
        year: h.year,
        cover_url: h.cover_url,
        cover_options,
        score: None,
    }
}

fn candidate_from_youtube(artist: String, title: String, cover_url: Option<String>) -> LookupCandidate {
    let cover_options = cover_url
        .as_ref()
        .map(|url| {
            vec![CoverOption {
                url: url.clone(),
                source: "youtube".to_string(),
                width: Some(480),
                height: Some(360),
                score: None,
            }]
        })
        .unwrap_or_default();
    LookupCandidate {
        recording_mbid: String::new(),
        release_mbid: String::new(),
        artist: normalize_artist_display(&artist),
        title: strip_title_mix_keywords(&title),
        album: String::new(),
        album_artist: None,
        track_number: None,
        year: None,
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
    youtube: &YoutubeState,
    item: &LookupInput,
    matching: &MatchingOptions,
) -> Result<LookupResult, String> {
    let started = Instant::now();
    let cover_deadline = Instant::now() + Duration::from_secs(6);
    let stem = item.filename_stem.trim();
    let (seed_artist, seed_title) = infer_artist_title(&item.artist, &item.title, stem);
    if matching.verbose_logs {
        eprintln!(
            "[smart_lookup_one] start path='{}' stem='{}' seed_artist='{}' seed_title='{}'",
            item.path,
            stem,
            seed_artist,
            seed_title
        );
    }
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
        amazon,
        youtube,
        &LookupInput {
            path: item.path.clone(),
            artist: seed_artist_for_queries.to_string(),
            title: seed_title_for_queries.to_string(),
            filename_stem: item.filename_stem.clone(),
        },
        matching,
    )
    .await;
    if matching.verbose_logs {
        eprintln!(
            "[smart_lookup_one] identified artists for path='{}': {:?}",
            item.path,
            artists
        );
    }
    let mut merged: Vec<LookupCandidate> = Vec::new();
    let mut cover_pool: Vec<RawCover> = Vec::new();
    let mut seen_cover_urls = HashSet::<String>::new();

    let mut searched_any = false;
    for a in artists.iter().take(3) {
        let residual = title_residual(stem, a);
        let query_title = if residual.trim().is_empty() {
            seed_title_for_queries.trim()
        } else {
            residual.trim()
        };
        let queries = build_query_variants(a, seed_title_for_queries, stem, query_title);
        for q in queries {
            if Instant::now() >= cover_deadline && cover_pool.len() >= 1 {
                break;
            }
            if matching.use_deezer {
                let pool_before = cover_pool.len();
                let dz = deezer_search_tracks(
                    deezer,
                    client,
                    &q,
                    (matching.limit as usize).max(12).min(15),
                )
                .await;
                let dz_len = dz.len();
                if !dz.is_empty() {
                    searched_any = true;
                }
                for h in dz {
                    if let Some(url) = h.cover_url.clone() {
                        push_raw_cover(
                            &mut cover_pool,
                            &mut seen_cover_urls,
                            RawCover {
                                url,
                                source: "deezer",
                                width: Some(1200),
                                height: Some(1200),
                                artist: Some(h.artist.clone()),
                                title: Some(h.title.clone()),
                            },
                        );
                    }
                    merged.push(candidate_from_deezer(h.artist, h.title, h.album, h.cover_url, h.year));
                }
                if dz_len > 0 && matching.verbose_logs {
                    eprintln!(
                        "[smart_lookup_one] path='{}' deezer q='{}' hits={} pool {}->{}",
                        item.path,
                        q,
                        dz_len,
                        pool_before,
                        cover_pool.len()
                    );
                }
            }
            if matching.use_spotify {
                let pool_before = cover_pool.len();
                let sp = spotify_search_tracks(spotify, client, &q, matching.limit as usize).await;
                let sp_len = sp.len();
                if !sp.is_empty() {
                    searched_any = true;
                }
                for h in sp {
                    if let Some(url) = h.cover_url.clone() {
                        push_raw_cover(
                            &mut cover_pool,
                            &mut seen_cover_urls,
                            RawCover {
                                url,
                                source: "spotify",
                                width: Some(640),
                                height: Some(640),
                                artist: Some(h.artist.clone()),
                                title: Some(h.title.clone()),
                            },
                        );
                    }
                    merged.push(candidate_from_spotify(h.artist, h.title, h.album, h.cover_url, h.year));
                }
                if sp_len > 0 && matching.verbose_logs {
                    eprintln!(
                        "[smart_lookup_one] path='{}' spotify q='{}' hits={} pool {}->{}",
                        item.path,
                        q,
                        sp_len,
                        pool_before,
                        cover_pool.len()
                    );
                }
            }
            if matching.use_amazon {
                let pool_before = cover_pool.len();
                let hits = itunes_search_cover_urls(
                    amazon,
                    client,
                    a,
                    query_title,
                    8,
                    matching.verbose_logs,
                )
                .await;
                if !hits.is_empty() {
                    searched_any = true;
                }
                let hits_len = hits.len();
                for hit in hits {
                    push_raw_cover(
                        &mut cover_pool,
                        &mut seen_cover_urls,
                        RawCover {
                            url: hit.url,
                            source: "itunes",
                            width: None,
                            height: None,
                            artist: Some(a.clone()),
                            title: Some(query_title.to_string()),
                        },
                    );
                }
                if hits_len > 0 && matching.verbose_logs {
                    eprintln!(
                        "[smart_lookup_one] path='{}' itunes a='{}' title='{}' hits={} pool {}->{}",
                        item.path,
                        a,
                        query_title,
                        hits_len,
                        pool_before,
                        cover_pool.len()
                    );
                }
            }
            if matching.use_amazon {
                let it_hits = itunes_search_tracks(
                    amazon,
                    client,
                    a,
                    query_title,
                    (matching.limit as usize).max(8).min(15),
                    matching.verbose_logs,
                )
                .await;
                for h in it_hits {
                    if let Some(url) = h.cover_url.clone() {
                        push_raw_cover(
                            &mut cover_pool,
                            &mut seen_cover_urls,
                            RawCover {
                                url,
                                source: "itunes",
                                width: Some(1200),
                                height: Some(1200),
                                artist: Some(h.artist.clone()),
                                title: Some(h.title.clone()),
                            },
                        );
                    }
                    merged.push(candidate_from_itunes(h));
                    searched_any = true;
                }
            }
            if matching.use_youtube {
                let yt = youtube_search_tracks(
                    youtube,
                    client,
                    a,
                    query_title,
                    (matching.limit as usize).max(4).min(10),
                    matching.verbose_logs,
                )
                .await;
                for h in yt {
                    if let Some(url) = h.cover_url.clone() {
                        push_raw_cover(
                            &mut cover_pool,
                            &mut seen_cover_urls,
                            RawCover {
                                url,
                                source: "youtube",
                                width: Some(480),
                                height: Some(360),
                                artist: Some(h.artist.clone()),
                                title: Some(h.title.clone()),
                            },
                        );
                    }
                    merged.push(candidate_from_youtube(h.artist, h.title, h.cover_url));
                    searched_any = true;
                }
            }
            if cover_pool.len() >= 4 {
                break;
            }
        }
        if cover_pool.len() >= 4 {
            break;
        }
    }

    if !searched_any {
        if matching.use_deezer {
            let q = format!("{} {}", seed_artist_for_queries.trim(), seed_title_for_queries.trim());
            let dz = deezer_search_tracks(
                deezer,
                client,
                &q,
                (matching.limit as usize).max(12).min(15),
            )
            .await;
            for h in dz {
                if let Some(url) = h.cover_url.clone() {
                    push_raw_cover(
                        &mut cover_pool,
                        &mut seen_cover_urls,
                        RawCover {
                            url,
                            source: "deezer",
                            width: Some(1200),
                            height: Some(1200),
                            artist: Some(h.artist.clone()),
                            title: Some(h.title.clone()),
                        },
                    );
                }
                merged.push(candidate_from_deezer(h.artist, h.title, h.album, h.cover_url, h.year));
            }
        }
        if matching.use_spotify {
            let q = format!("{} {}", seed_artist_for_queries.trim(), seed_title_for_queries.trim());
            let sp = spotify_search_tracks(spotify, client, &q, matching.limit as usize).await;
            for h in sp {
                if let Some(url) = h.cover_url.clone() {
                    push_raw_cover(
                        &mut cover_pool,
                        &mut seen_cover_urls,
                        RawCover {
                            url,
                            source: "spotify",
                            width: Some(640),
                            height: Some(640),
                            artist: Some(h.artist.clone()),
                            title: Some(h.title.clone()),
                        },
                    );
                }
                merged.push(candidate_from_spotify(h.artist, h.title, h.album, h.cover_url, h.year));
            }
        }
        if matching.use_amazon {
            for hit in itunes_search_cover_urls(
                amazon,
                client,
                seed_artist_for_queries,
                seed_title_for_queries,
                6,
                matching.verbose_logs,
            )
            .await
            {
                push_raw_cover(
                    &mut cover_pool,
                    &mut seen_cover_urls,
                    RawCover {
                        url: hit.url,
                        source: "itunes",
                        width: None,
                        height: None,
                        artist: Some(seed_artist_for_queries.to_string()),
                        title: Some(seed_title_for_queries.to_string()),
                    },
                );
            }
            let it_hits = itunes_search_tracks(
                amazon,
                client,
                seed_artist_for_queries,
                seed_title_for_queries,
                (matching.limit as usize).max(8).min(15),
                matching.verbose_logs,
            )
            .await;
            for h in it_hits {
                merged.push(candidate_from_itunes(h));
            }
        }
        if matching.use_youtube {
            let yt_hits = youtube_search_tracks(
                youtube,
                client,
                seed_artist_for_queries,
                seed_title_for_queries,
                (matching.limit as usize).max(4).min(10),
                matching.verbose_logs,
            )
            .await;
            for h in yt_hits {
                merged.push(candidate_from_youtube(h.artist, h.title, h.cover_url));
            }
        }
    }

    if merged.is_empty() {
        merged.push(LookupCandidate {
            recording_mbid: String::new(),
            release_mbid: String::new(),
            artist: seed_artist,
            title: strip_title_mix_keywords(&seed_title),
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
    if matching.verbose_logs {
        eprintln!(
            "[smart_lookup_one] end path='{}' candidates={} cover_pool={} first_cover_opts={} elapsedMs={}",
            item.path,
            candidates.len(),
            cover_pool.len(),
            candidates
                .first()
                .map(|c| c.cover_options.len())
                .unwrap_or(0),
            started.elapsed().as_millis()
        );
    }
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
        c.title = strip_title_mix_keywords(&c.title);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_candidate(artist: &str, title: &str, source: &str) -> LookupCandidate {
        LookupCandidate {
            recording_mbid: String::new(),
            release_mbid: String::new(),
            artist: artist.to_string(),
            title: title.to_string(),
            album: String::new(),
            album_artist: None,
            track_number: None,
            year: None,
            cover_url: Some("https://x/y.jpg".into()),
            cover_options: vec![CoverOption {
                url: "https://x/y.jpg".into(),
                source: source.to_string(),
                width: Some(1200),
                height: Some(1200),
                score: None,
            }],
            score: None,
        }
    }

    #[test]
    fn strict_filter_keeps_only_top_relevant_candidates() {
        let stem = "Layla Benitez All The Time";
        let cands = vec![
            mk_candidate("Layla Benitez", "All The Time", "deezer"),
            mk_candidate("Layla Benitez", "All The Time (Live)", "youtube"),
            mk_candidate("Random Artist", "Unrelated Track", "youtube"),
            mk_candidate("Another Artist", "Different Song", "spotify"),
        ];
        let out = apply_dynamic_relevance_filter(cands, stem);
        assert!(!out.is_empty());
        assert!(out.iter().all(|c| c.artist.to_lowercase().contains("layla") || c.title.to_lowercase().contains("all the time")));
    }

    #[test]
    fn balanced_filter_preserves_multiple_candidates_when_uncertain() {
        let stem = "DNA";
        let cands = vec![
            mk_candidate("Adam Beyer", "DNA", "deezer"),
            mk_candidate("Kendrick Lamar", "DNA.", "itunes"),
            mk_candidate("Empire of the Sun", "DNA", "youtube"),
        ];
        let out = apply_dynamic_relevance_filter(cands, stem);
        assert!(out.len() >= 2);
    }
}
