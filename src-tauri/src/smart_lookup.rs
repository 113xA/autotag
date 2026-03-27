use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use reqwest::Client;
use regex::Regex;
use std::sync::OnceLock;

use crate::amazon::{
    search_cover_urls as itunes_search_cover_urls, search_tracks as itunes_search_tracks,
    AmazonState, ItunesTrackHit,
};
use crate::discogs::{search_tracks as discogs_search_tracks, DiscogsState, DiscogsTrackHit};
use crate::deezer::{search_tracks as deezer_search_tracks, DeezerState};
use crate::filename_catalog::{resolve_from_stem, stem_overlap_score};
use crate::models::{CoverOption, LookupCandidate, LookupInput, LookupResult};
use crate::musicbrainz::MbState;
use crate::options::MatchingOptions;
use crate::scoring::{
    bidirectional_score, extract_modifiers, legacy_relevance_score, ParsedFilename,
};
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

fn split_compound_pair(s: &str) -> Option<(String, String)> {
    let raw = s.trim();
    for sep in [" - ", " — ", " – "] {
        if let Some((a, t)) = raw.split_once(sep) {
            let aa = a.trim();
            let tt = t.trim();
            if !aa.is_empty() && !tt.is_empty() {
                return Some((aa.to_string(), tt.to_string()));
            }
        }
    }
    None
}

fn pair_similarity(a: &str, b: &str) -> f64 {
    let na = normalize_exact(a);
    let nb = normalize_exact(b);
    if na.is_empty() || nb.is_empty() {
        return 0.0;
    }
    if na == nb {
        return 1.0;
    }
    stem_overlap_score(&na, "", &nb)
}

fn sanitize_candidate_identity(c: &mut LookupCandidate, parsed: &ParsedFilename) {
    let mut artist = c.artist.trim().to_string();
    let mut title = c.title.trim().to_string();

    // Case 1: title is "Artist - Title" while artist already matches left side.
    if let Some((left, right)) = split_compound_pair(&title) {
        let left_matches_artist = pair_similarity(&artist, &left) >= 0.75;
        let left_matches_clean_artist = pair_similarity(&parsed.clean_artist, &left) >= 0.75;
        let right_matches_clean_title = pair_similarity(&parsed.clean_title, &right) >= 0.60;
        if left_matches_artist || (left_matches_clean_artist && right_matches_clean_title) {
            artist = if artist.is_empty() { left } else { artist };
            title = right;
        }
    }

    // Case 2: artist is "Artist - Title" and title is weak/duplicated.
    if let Some((left, right)) = split_compound_pair(&artist) {
        let title_matches_right = pair_similarity(&title, &right) >= 0.65;
        let title_matches_left = pair_similarity(&title, &left) >= 0.65;
        let right_matches_clean_title = pair_similarity(&parsed.clean_title, &right) >= 0.60;
        let left_matches_clean_artist = pair_similarity(&parsed.clean_artist, &left) >= 0.60;
        if title_matches_right || (!title_matches_left && left_matches_clean_artist && right_matches_clean_title)
        {
            artist = left;
            title = if title_matches_right || title.is_empty() {
                right
            } else {
                title
            };
        }
    }

    // Case 3: identical artist/title often indicates blended extraction.
    if pair_similarity(&artist, &title) >= 0.95 {
        if let Some((left, right)) = split_compound_pair(&title) {
            let left_ok = pair_similarity(&parsed.clean_artist, &left) >= 0.55;
            let right_ok = pair_similarity(&parsed.clean_title, &right) >= 0.45;
            if left_ok || right_ok {
                artist = left;
                title = right;
            }
        }
    }

    c.artist = normalize_artist_display(artist.trim());
    c.title = title.trim().to_string();
}

fn exact_pair_match(artist: &str, title: &str, expected_artist: &str, expected_title: &str) -> bool {
    normalize_exact(artist) == normalize_exact(expected_artist)
        && normalize_exact(&strip_title_mix_keywords(title))
            == normalize_exact(&strip_title_mix_keywords(expected_title))
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
        .replace(" and ", ", ")
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
            r"(?i)(?:\s*(?:[-–—]\s*)?[\(\[]?\s*(?:extended mix|extended version|extended edit|extended|original mix|original version|club mix|dub mix|radio edit|radio mix|instrumental|bootleg|mashup|vip|edit|version|mix)\s*[\)\]]?)\s*$",
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
        // Keep full title (including remix/edit/version); only strip for matching.
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
        "deezer" => 0.92,
        "itunes" => 0.88,
        "discogs" => 0.80,
        "youtube" => 0.70,
        "spotify" => 0.66,
        "amazon" => 0.70,
        _ => 0.60,
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

/// Collapse whitespace; normalize underscores so Deezer/iTunes queries match cleaned filenames.
fn normalize_stem_for_remote_query(stem: &str) -> String {
    let s = stem.replace('_', " ");
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"\s+").unwrap());
    re.replace_all(s.trim(), " ").to_string()
}

/// Only adopt Pass-0 API seed when it agrees with filename-derived artist/title or clearly wins on stem overlap.
fn pass0_seed_trustworthy(
    top: &LookupCandidate,
    baseline_artist: &str,
    baseline_title: &str,
    stem: &str,
) -> bool {
    let ba = baseline_artist.trim();
    let bt = baseline_title.trim();
    if ba.is_empty() && bt.is_empty() {
        return true;
    }
    let stem_top = stem_overlap_score(stem, &top.artist, &top.title);
    let stem_base = stem_overlap_score(stem, ba, bt);
    let artist_ok = ba.is_empty() || pair_similarity(&top.artist, ba) >= 0.32;
    let title_ok = bt.is_empty() || pair_similarity(&top.title, bt) >= 0.45;
    if artist_ok && title_ok {
        return true;
    }
    stem_top >= stem_base + 0.12 && pair_similarity(&top.title, bt) >= 0.35
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

async fn rebuild_cover_pool_after_metadata(
    state: &MbState,
    client: &Client,
    deezer: &DeezerState,
    amazon: &AmazonState,
    discogs: &DiscogsState,
    candidates: &[LookupCandidate],
    verified_pair: Option<(&str, &str)>,
    stem: &str,
    matching: &MatchingOptions,
) -> Vec<RawCover> {
    let mut pool: Vec<RawCover> = Vec::new();
    let mut seen = HashSet::<String>::new();

    fn source_static(s: &str) -> &'static str {
        match s {
            "musicbrainz" => "musicbrainz",
            "deezer" => "deezer",
            "itunes" => "itunes",
            "discogs" => "discogs",
            "spotify" => "spotify",
            "youtube" => "youtube",
            _ => "candidate",
        }
    }

    // Start from already-known cover urls/options on candidates (fast, no network).
    for c in candidates.iter().take(6) {
        if let Some(url) = c.cover_url.as_ref().filter(|u| !u.trim().is_empty()) {
            push_raw_cover(
                &mut pool,
                &mut seen,
                RawCover {
                    url: url.clone(),
                    source: "candidate",
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
                },
            );
        }
        for co in &c.cover_options {
            push_raw_cover(
                &mut pool,
                &mut seen,
                RawCover {
                    url: co.url.clone(),
                    source: source_static(co.source.as_str()),
                    width: co.width,
                    height: co.height,
                    artist: Some(c.artist.clone()),
                    title: Some(c.title.clone()),
                },
            );
        }
        if pool.len() >= 6 {
            break;
        }
    }

    // If we have a verified exact pair, use that for trusted cover searches.
    let (artist, title) = if let Some((a, t)) = verified_pair {
        (a.to_string(), t.to_string())
    } else if let Some(top) = candidates.first() {
        (top.artist.clone(), top.title.clone())
    } else {
        return pool;
    };

    // Always try MusicBrainz/CAA indirectly by re-running MB lookup for the final pair.
    // (This also helps recover covers when the best candidate came from sources without art.)
    let mb_cov = musicbrainz_only_lookup_one(
        state,
        &LookupInput {
            path: String::new(),
            artist: artist.clone(),
            title: title.clone(),
            filename_stem: stem.to_string(),
        },
        matching,
    )
    .await;
    if let Ok(mb_cov) = mb_cov {
        for c in mb_cov.candidates.iter().take(2) {
            if let Some(url) = c.cover_url.as_ref().filter(|u| !u.trim().is_empty()) {
                push_raw_cover(
                    &mut pool,
                    &mut seen,
                    RawCover {
                        url: url.clone(),
                        source: "musicbrainz",
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
                    },
                );
            }
        }
    }

    // Apple / iTunes: trusted for cover art, validate via track lookup results.
    if matching.use_amazon {
        let it_hits = itunes_search_tracks(amazon, client, &artist, &title, 10, matching.verbose_logs).await;
        for h in it_hits {
            if let Some(url) = h.cover_url.clone() {
                if exact_pair_match(&h.artist, &h.title, &artist, &title) {
                    push_raw_cover(
                        &mut pool,
                        &mut seen,
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
            }
            if pool.len() >= 8 {
                break;
            }
        }
    }

    // Deezer: good quality covers; query by final artist/title.
    if matching.use_deezer {
        let q = format!("{} {}", artist.trim(), title.trim());
        let dz = deezer_search_tracks(deezer, client, &q, 8).await;
        for h in dz {
            if let Some(url) = h.cover_url.clone() {
                // Avoid adding wildly-off results.
                let rel = stem_overlap_score(&format!("{} - {}", artist, title), &h.artist, &h.title);
                if rel >= 0.55 {
                    push_raw_cover(
                        &mut pool,
                        &mut seen,
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
            }
            if pool.len() >= 10 {
                break;
            }
        }
    }

    // Discogs: trusted release-level images (when token is present).
    if matching.use_discogs {
        let disc_hits = discogs_search_tracks(discogs, client, &artist, &title, 3, matching.verbose_logs).await;
        for h in disc_hits {
            if let Some(url) = h.cover_url.clone() {
                if exact_pair_match(&h.artist, &h.title, &artist, &title) {
                    push_raw_cover(
                        &mut pool,
                        &mut seen,
                        RawCover {
                            url,
                            source: "discogs",
                            width: None,
                            height: None,
                            artist: Some(h.artist.clone()),
                            title: Some(h.title.clone()),
                        },
                    );
                }
            }
            if pool.len() >= 12 {
                break;
            }
        }
    }

    pool
}

fn candidate_relevance_score(stem: &str, c: &LookupCandidate) -> f64 {
    legacy_relevance_score(stem, c)
}

fn candidate_relevance_score_parsed(parsed: &ParsedFilename, c: &LookupCandidate) -> f64 {
    let source = infer_candidate_source(c);
    let (score, _) = bidirectional_score(parsed, c, source);
    score / 100.0
}

fn infer_candidate_source(c: &LookupCandidate) -> &'static str {
    if !c.recording_mbid.is_empty() {
        return "musicbrainz";
    }
    for co in &c.cover_options {
        match co.source.as_str() {
            "deezer" => return "deezer",
            "itunes" => return "itunes",
            "discogs" => return "discogs",
            "spotify" => return "spotify",
            "youtube" => return "youtube",
            _ => {}
        }
    }
    "unknown"
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

fn dedupe_and_sort_parsed(
    mut cands: Vec<LookupCandidate>,
    stem: &str,
    parsed: &ParsedFilename,
) -> Vec<LookupCandidate> {
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
        let sa = candidate_relevance_score_parsed(parsed, a);
        let sb = candidate_relevance_score_parsed(parsed, b);
        sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
    });
    apply_dynamic_relevance_filter_parsed(cands, stem, parsed)
}

fn apply_dynamic_relevance_filter_parsed(
    mut cands: Vec<LookupCandidate>,
    _stem: &str,
    parsed: &ParsedFilename,
) -> Vec<LookupCandidate> {
    if cands.len() <= 1 {
        return cands;
    }
    let mut scored = cands
        .drain(..)
        .map(|c| {
            let s = candidate_relevance_score_parsed(parsed, &c);
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
    scored
        .into_iter()
        .filter(|(_, s)| *s >= min)
        .take(keep)
        .map(|(c, _)| c)
        .collect()
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
        title: title.trim().to_string(),
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
        title: title.trim().to_string(),
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
        title: h.title.trim().to_string(),
        album: h.album.unwrap_or_default(),
        album_artist: None,
        track_number: None,
        year: h.year,
        cover_url: h.cover_url,
        cover_options,
        score: None,
    }
}

fn candidate_from_discogs(h: DiscogsTrackHit) -> LookupCandidate {
    let cover_options = h
        .cover_url
        .as_ref()
        .map(|url| {
            vec![CoverOption {
                url: url.clone(),
                source: "discogs".to_string(),
                width: None,
                height: None,
                score: None,
            }]
        })
        .unwrap_or_default();
    LookupCandidate {
        recording_mbid: String::new(),
        release_mbid: String::new(),
        artist: normalize_artist_display(&h.artist),
        title: h.title.trim().to_string(),
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
        title: title.trim().to_string(),
        album: String::new(),
        album_artist: None,
        track_number: None,
        year: None,
        cover_url,
        cover_options,
        score: None,
    }
}

async fn raw_filename_seed_candidates(
    client: &Client,
    deezer: &DeezerState,
    spotify: &SpotifyState,
    amazon: &AmazonState,
    youtube: &YoutubeState,
    discogs: &DiscogsState,
    stem: &str,
    matching: &MatchingOptions,
) -> Vec<LookupCandidate> {
    let q = normalize_stem_for_remote_query(stem);
    if q.trim().is_empty() {
        return vec![];
    }
    let mut merged: Vec<LookupCandidate> = Vec::new();
    // Query by full raw stem first (before any strip). This recovers cases where
    // the cleaned split guessed artist/title incorrectly or merged them.
    if matching.use_deezer {
        for h in deezer_search_tracks(deezer, client, &q, (matching.limit as usize).max(10).min(15)).await
        {
            merged.push(candidate_from_deezer(h.artist, h.title, h.album, h.cover_url, h.year));
        }
    }
    if matching.use_spotify {
        for h in spotify_search_tracks(spotify, client, &q, (matching.limit as usize).max(8).min(12)).await
        {
            merged.push(candidate_from_spotify(h.artist, h.title, h.album, h.cover_url, h.year));
        }
    }
    if matching.use_amazon {
        for h in itunes_search_tracks(
            amazon,
            client,
            &q,
            &q,
            (matching.limit as usize).max(8).min(12),
            matching.verbose_logs,
        )
        .await
        {
            merged.push(candidate_from_itunes(h));
        }
    }
    if matching.use_youtube {
        for h in youtube_search_tracks(
            youtube,
            client,
            &q,
            &q,
            (matching.limit as usize).max(4).min(8),
            matching.verbose_logs,
        )
        .await
        {
            merged.push(candidate_from_youtube(h.artist, h.title, h.cover_url));
        }
    }
    if matching.use_discogs {
        for h in discogs_search_tracks(discogs, client, &q, &q, 2, matching.verbose_logs).await {
            merged.push(candidate_from_discogs(h));
        }
    }
    merged
}

async fn query_sources_parallel(
    client: &Client,
    deezer: &DeezerState,
    spotify: &SpotifyState,
    amazon: &AmazonState,
    youtube: &YoutubeState,
    discogs: &DiscogsState,
    artist: &str,
    query_title: &str,
    matching: &MatchingOptions,
    trusted_covers: bool,
) -> (Vec<LookupCandidate>, Vec<RawCover>, bool) {
    let deezer_fut = async {
        if !matching.use_deezer {
            return (Vec::<LookupCandidate>::new(), Vec::<RawCover>::new(), false);
        }
        let hits = deezer_search_tracks(
            deezer,
            client,
            &format!("{} {}", artist.trim(), query_title.trim()),
            (matching.limit as usize).max(12).min(15),
        )
        .await;
        let mut cands = Vec::with_capacity(hits.len());
        let mut covers = Vec::new();
        for h in hits {
            if !trusted_covers {
                if let Some(url) = h.cover_url.clone() {
                    covers.push(RawCover {
                        url,
                        source: "deezer",
                        width: Some(1200),
                        height: Some(1200),
                        artist: Some(h.artist.clone()),
                        title: Some(h.title.clone()),
                    });
                }
            }
            cands.push(candidate_from_deezer(h.artist, h.title, h.album, h.cover_url, h.year));
        }
        let searched = !cands.is_empty();
        (cands, covers, searched)
    };

    let spotify_fut = async {
        if !matching.use_spotify {
            return (Vec::<LookupCandidate>::new(), Vec::<RawCover>::new(), false);
        }
        let hits = spotify_search_tracks(
            spotify,
            client,
            &format!("{} {}", artist.trim(), query_title.trim()),
            matching.limit as usize,
        )
        .await;
        let mut cands = Vec::with_capacity(hits.len());
        let mut covers = Vec::new();
        for h in hits {
            if !trusted_covers {
                if let Some(url) = h.cover_url.clone() {
                    covers.push(RawCover {
                        url,
                        source: "spotify",
                        width: Some(640),
                        height: Some(640),
                        artist: Some(h.artist.clone()),
                        title: Some(h.title.clone()),
                    });
                }
            }
            cands.push(candidate_from_spotify(h.artist, h.title, h.album, h.cover_url, h.year));
        }
        let searched = !cands.is_empty();
        (cands, covers, searched)
    };

    let amazon_fut = async {
        if !matching.use_amazon {
            return (Vec::<LookupCandidate>::new(), Vec::<RawCover>::new(), false);
        }
        let mut covers = Vec::<RawCover>::new();
        let mut cands = Vec::<LookupCandidate>::new();
        let mut searched = false;
        if !trusted_covers {
            let cover_hits =
                itunes_search_cover_urls(amazon, client, artist, query_title, 8, matching.verbose_logs)
                    .await;
            if !cover_hits.is_empty() {
                searched = true;
            }
            for hit in cover_hits {
                covers.push(RawCover {
                    url: hit.url,
                    source: "itunes",
                    width: None,
                    height: None,
                    artist: Some(artist.to_string()),
                    title: Some(query_title.to_string()),
                });
            }
        }
        let track_hits = itunes_search_tracks(
            amazon,
            client,
            artist,
            query_title,
            (matching.limit as usize).max(8).min(15),
            matching.verbose_logs,
        )
        .await;
        if !track_hits.is_empty() {
            searched = true;
        }
        for h in track_hits {
            if !trusted_covers {
                if let Some(url) = h.cover_url.clone() {
                    covers.push(RawCover {
                        url,
                        source: "itunes",
                        width: Some(1200),
                        height: Some(1200),
                        artist: Some(h.artist.clone()),
                        title: Some(h.title.clone()),
                    });
                }
            }
            cands.push(candidate_from_itunes(h));
        }
        (cands, covers, searched)
    };

    let youtube_fut = async {
        if !matching.use_youtube {
            return (Vec::<LookupCandidate>::new(), Vec::<RawCover>::new(), false);
        }
        let hits = youtube_search_tracks(
            youtube,
            client,
            artist,
            query_title,
            (matching.limit as usize).max(4).min(10),
            matching.verbose_logs,
        )
        .await;
        let mut cands = Vec::with_capacity(hits.len());
        let mut covers = Vec::new();
        for h in hits {
            if !trusted_covers {
                if let Some(url) = h.cover_url.clone() {
                    covers.push(RawCover {
                        url,
                        source: "youtube",
                        width: Some(480),
                        height: Some(360),
                        artist: Some(h.artist.clone()),
                        title: Some(h.title.clone()),
                    });
                }
            }
            cands.push(candidate_from_youtube(h.artist, h.title, h.cover_url));
        }
        let searched = !cands.is_empty();
        (cands, covers, searched)
    };

    let discogs_fut = async {
        if !matching.use_discogs {
            return (Vec::<LookupCandidate>::new(), Vec::<RawCover>::new(), false);
        }
        let hits = discogs_search_tracks(
            discogs,
            client,
            artist,
            query_title,
            (matching.limit as usize).min(4).max(2),
            matching.verbose_logs,
        )
        .await;
        let mut cands = Vec::with_capacity(hits.len());
        let mut covers = Vec::new();
        for h in hits {
            if !trusted_covers {
                if let Some(url) = h.cover_url.clone() {
                    covers.push(RawCover {
                        url,
                        source: "discogs",
                        width: None,
                        height: None,
                        artist: Some(h.artist.clone()),
                        title: Some(h.title.clone()),
                    });
                }
            }
            cands.push(candidate_from_discogs(h));
        }
        let searched = !cands.is_empty();
        (cands, covers, searched)
    };

    let (dz, sp, am, yt, dc) =
        tokio::join!(deezer_fut, spotify_fut, amazon_fut, youtube_fut, discogs_fut);

    let mut merged = Vec::new();
    let mut covers = Vec::new();
    let mut searched_any = false;

    for (mut c, mut cv, searched) in [dz, sp, am, yt, dc] {
        merged.append(&mut c);
        covers.append(&mut cv);
        searched_any |= searched;
    }

    (merged, covers, searched_any)
}

/// Fill missing album / year / MBIDs from MusicBrainz for the best-ranked candidates
/// before any dedicated cover-art harvesting (see lookup protocol in README).
async fn enrich_top_candidates_album_year_from_mb(
    state: &MbState,
    candidates: &mut [LookupCandidate],
    stem: &str,
    matching: &MatchingOptions,
) {
    for c in candidates.iter_mut().take(2) {
        let needs_meta = c.album.trim().is_empty() || c.year.is_none();
        if !needs_meta {
            continue;
        }
        let Ok(res) = musicbrainz_only_lookup_one(
            state,
            &LookupInput {
                path: String::new(),
                artist: c.artist.clone(),
                title: c.title.clone(),
                filename_stem: stem.to_string(),
            },
            matching,
        )
        .await
        else {
            continue;
        };
        let Some(mb) = res.candidates.first() else {
            continue;
        };
        if c.album.trim().is_empty() && !mb.album.trim().is_empty() {
            c.album = mb.album.clone();
        }
        if c.year.is_none() {
            c.year = mb.year;
        }
        if c
            .album_artist
            .as_ref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
        {
            if let Some(ref aa) = mb.album_artist {
                if !aa.trim().is_empty() {
                    c.album_artist = Some(aa.clone());
                }
            }
        }
        if c.recording_mbid.is_empty() && !mb.recording_mbid.is_empty() {
            c.recording_mbid = mb.recording_mbid.clone();
        }
        if c.release_mbid.is_empty() && !mb.release_mbid.is_empty() {
            c.release_mbid = mb.release_mbid.clone();
        }
    }
}

pub async fn smart_lookup_one(
    state: &MbState,
    client: &Client,
    deezer: &DeezerState,
    spotify: &SpotifyState,
    amazon: &AmazonState,
    youtube: &YoutubeState,
    discogs: &DiscogsState,
    item: &LookupInput,
    matching: &MatchingOptions,
) -> Result<LookupResult, String> {
    let started = Instant::now();
    let cover_deadline = Instant::now() + Duration::from_secs(6);
    let stem = item.filename_stem.trim();

    let modifiers = extract_modifiers(stem);
    let baseline_artist = item.artist.trim().to_string();
    let baseline_title = item.title.trim().to_string();

    let mut parsed = ParsedFilename {
        raw_stem: stem.to_string(),
        raw_lower: stem.to_lowercase(),
        clean_artist: baseline_artist.clone(),
        clean_title: baseline_title.clone(),
        modifiers,
    };

    let (mut seed_artist, mut seed_title) = infer_artist_title(&item.artist, &item.title, stem);

    // Pass 0: try to seed artist/title from full raw filename lookup.
    // Guarded: a wrong top hit must not override filename parse or scoring baseline.
    if !stem.is_empty() {
        let seeded = raw_filename_seed_candidates(
            client, deezer, spotify, amazon, youtube, discogs, stem, matching,
        )
        .await;
        if let Some(top) = dedupe_and_sort(seeded, stem).first() {
            if !top.artist.trim().is_empty() && !top.title.trim().is_empty() {
                let adopt_baseline = if baseline_artist.is_empty() && baseline_title.is_empty() {
                    true
                } else {
                    pass0_seed_trustworthy(
                        top,
                        &baseline_artist,
                        &baseline_title,
                        stem,
                    )
                };
                if adopt_baseline {
                    seed_artist = top.artist.clone();
                    seed_title = top.title.clone();
                }
            }
        }
    }
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
    }
    .to_string();
    let seed_title_for_queries = if seed_title.is_empty() {
        item.title.as_str()
    } else {
        seed_title.as_str()
    }
    .to_string();

    let mut verified: Option<(String, String)> = None;
    let mut verified_album: Option<String> = None;
    let mut verified_year: Option<u32> = None;

    // Filename-first lookup only (no upfront MusicBrainz pre-verification).
    let artists = identify_artists(
        client,
        deezer,
        spotify,
        amazon,
        youtube,
        &LookupInput {
            path: item.path.clone(),
            artist: seed_artist_for_queries.clone(),
            title: seed_title_for_queries.clone(),
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

    // Parallel queries pass `trusted_covers: true` so we do not run cover-only prefetch or
    // collect raw cover rows until after album/year enrichment and final ranking.
    let mut searched_any = false;
    for a in artists.iter().take(3) {
        let residual = title_residual(stem, a);
        let query_title = if residual.trim().is_empty() {
            seed_title_for_queries.trim()
        } else {
            residual.trim()
        };
        let queries = build_query_variants(a, &seed_title_for_queries, stem, query_title);
        for q in queries {
            if Instant::now() >= cover_deadline && !merged.is_empty() {
                break;
            }
            let (mut cands, _raw_covers, hit_any) = query_sources_parallel(
                client,
                deezer,
                spotify,
                amazon,
                youtube,
                discogs,
                a,
                &q,
                matching,
                true,
            )
            .await;
            searched_any |= hit_any;
            merged.append(&mut cands);
            if matching.verbose_logs && hit_any {
                eprintln!(
                    "[smart_lookup_one] path='{}' parallel q='{}' merged_total={}",
                    item.path,
                    q,
                    merged.len(),
                );
            }
            if merged.len() >= 48 {
                break;
            }
        }
        if merged.len() >= 48 {
            break;
        }
    }

    if !searched_any {
        let q_artist = seed_artist_for_queries.clone();
        let q_title = seed_title_for_queries.clone();
        let (mut cands, _raw_covers, _hit_any) = query_sources_parallel(
            client,
            deezer,
            spotify,
            amazon,
            youtube,
            discogs,
            &q_artist,
            &q_title,
            matching,
            true,
        )
        .await;
        merged.append(&mut cands);
    }

    if merged.is_empty() {
        merged.push(LookupCandidate {
            recording_mbid: String::new(),
            release_mbid: String::new(),
            artist: seed_artist,
            title: seed_title.trim().to_string(),
            album: String::new(),
            album_artist: None,
            track_number: None,
            year: None,
            cover_url: None,
            cover_options: vec![],
            score: None,
        });
    }

    // Scoring baseline stays the filename-derived strings from scan, not Pass-0 API guesses.
    if baseline_artist.is_empty() && baseline_title.is_empty() {
        parsed.clean_artist = seed_artist_for_queries.clone();
        parsed.clean_title = seed_title_for_queries.clone();
    }

    for c in &mut merged {
        sanitize_candidate_identity(c, &parsed);
    }
    let mut candidates = dedupe_and_sort_parsed(merged, stem, &parsed);

    // Album / release year from MusicBrainz before cover-art pool build.
    enrich_top_candidates_album_year_from_mb(state, &mut candidates, stem, matching).await;

    let mut exact_pair_found = false;

    // Optional post-filename verification: run MusicBrainz only after we already have
    // filename-driven candidate proposals.
    if matching.verify_musicbrainz_after_filename && verified.is_none() {
        if let Some(top) = candidates.first() {
            let mb_verify = musicbrainz_only_lookup_one(
                state,
                &LookupInput {
                    path: item.path.clone(),
                    artist: top.artist.clone(),
                    title: top.title.clone(),
                    filename_stem: item.filename_stem.clone(),
                },
                matching,
            )
            .await;
            if let Ok(mb_verify) = mb_verify {
                if let Some(mb_top) = mb_verify.candidates.first() {
                    if exact_pair_match(&mb_top.artist, &mb_top.title, &top.artist, &top.title) {
                        verified = Some((mb_top.artist.clone(), mb_top.title.clone()));
                        verified_album = Some(mb_top.album.clone());
                        verified_year = mb_top.year;
                    }
                }
            }
        }
    }

    // If we verified artist/title from trusted sources, constrain candidates and covers to exact
    // normalized `(artist,title)` matches.
    if let Some((v_artist, v_title)) = &verified {
        let filtered = candidates
            .iter()
            .filter(|c| exact_pair_match(&c.artist, &c.title, v_artist, v_title))
            .cloned()
            .collect::<Vec<_>>();
        if !filtered.is_empty() {
            exact_pair_found = true;
            candidates = filtered;
        }

        for c in &mut candidates {
            c.cover_url = None;
            c.cover_options = vec![];

            // If we verified artist/title, we also keep the “original” album + year from that
            // trusted MusicBrainz lookup.
            if let Some(a) = verified_album
                .as_deref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
            {
                c.album = a.to_string();
            }
            if let Some(y) = verified_year {
                c.year = Some(y);
            }
        }

        // Trusted cover pool: only include covers from sources that match the exact pair.
        cover_pool.clear();
        seen_cover_urls.clear();

        // 1) MusicBrainz / Cover Art Archive.
        let mb_cov = musicbrainz_only_lookup_one(
            state,
            &LookupInput {
                path: item.path.clone(),
                artist: v_artist.clone(),
                title: v_title.clone(),
                filename_stem: item.filename_stem.clone(),
            },
            matching,
        )
        .await;
        if let Ok(mb_cov) = mb_cov {
            if let Some(top) = mb_cov.candidates.first() {
                if exact_pair_match(&top.artist, &top.title, v_artist, v_title) {
                    if let Some(url) = top.cover_url.clone() {
                        let (w, h) = top
                            .cover_options
                            .iter()
                            .find(|co| co.url == url)
                            .map(|co| (co.width, co.height))
                            .unwrap_or((None, None));
                        push_raw_cover(
                            &mut cover_pool,
                            &mut seen_cover_urls,
                            RawCover {
                                url,
                                source: "musicbrainz",
                                width: w,
                                height: h,
                                artist: Some(top.artist.clone()),
                                title: Some(top.title.clone()),
                            },
                        );
                    }
                }
            }
        }

        // 2) Apple / iTunes (via Amazon endpoint): validate using `itunes_search_tracks`.
        if matching.use_amazon {
            let it_hits = itunes_search_tracks(
                amazon,
                client,
                v_artist,
                v_title,
                10,
                matching.verbose_logs,
            )
            .await;
            for h in it_hits {
                if let Some(url) = h.cover_url.clone() {
                    if exact_pair_match(&h.artist, &h.title, v_artist, v_title) {
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
                }
                if cover_pool.len() >= 4 {
                    break;
                }
            }
        }

        // 3) YouTube: validate using returned artist/title.
        if matching.use_youtube {
            let yt_hits =
                youtube_search_tracks(youtube, client, v_artist, v_title, 8, matching.verbose_logs)
                    .await;
            for h in yt_hits {
                if let Some(url) = h.cover_url.clone() {
                    if exact_pair_match(&h.artist, &h.title, v_artist, v_title) {
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
                }
                if cover_pool.len() >= 4 {
                    break;
                }
            }
        }

        // 4) Discogs: validate using returned artist/title.
        if matching.use_discogs {
            let disc_hits =
                discogs_search_tracks(discogs, client, v_artist, v_title, 4, matching.verbose_logs)
                    .await;
            for h in disc_hits {
                if let Some(url) = h.cover_url.clone() {
                    if exact_pair_match(&h.artist, &h.title, v_artist, v_title) {
                        push_raw_cover(
                            &mut cover_pool,
                            &mut seen_cover_urls,
                            RawCover {
                                url,
                                source: "discogs",
                                width: None,
                                height: None,
                                artist: Some(h.artist.clone()),
                                title: Some(h.title.clone()),
                            },
                        );
                    }
                }
                if cover_pool.len() >= 4 {
                    break;
                }
            }
        }
    }

    // Always rebuild the cover pool AFTER metadata is finalized.
    // This ensures cover art queries use the final artist/title/album/year rather than early guesses.
    cover_pool = rebuild_cover_pool_after_metadata(
        state,
        client,
        deezer,
        amazon,
        discogs,
        &candidates,
        verified
            .as_ref()
            .map(|(a, t)| (a.as_str(), t.as_str())),
        stem,
        matching,
    )
    .await;
    attach_best_cover_options(&mut candidates, &cover_pool);
    let (mut confidence, _) = confidence_for(&candidates, stem);
    if exact_pair_found {
        confidence = "high".into();
    }
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
        c.title = c.title.trim().to_string();
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

    #[test]
    fn normalize_exact_strips_punctuation_and_case() {
        assert_eq!(normalize_exact("Foo & Bar"), "foo bar");
        assert_eq!(normalize_exact("Kendrick Lamar"), "kendrick lamar");
        assert_eq!(normalize_exact("DNA."), "dna");
    }

    #[test]
    fn exact_pair_match_allows_punctuation_variants() {
        assert!(exact_pair_match(
            "Kendrick Lamar",
            "DNA.",
            "Kendrick Lamar",
            "DNA"
        ));
    }

    #[test]
    fn exact_pair_filtering_keeps_only_exact_normalized_pair() {
        let v_artist = "Kendrick Lamar";
        let v_title = "DNA";
        let cands = vec![
            mk_candidate("Kendrick Lamar", "DNA.", "itunes"),
            mk_candidate("Kendrick Lamar", "Different", "itunes"),
            mk_candidate("Other Artist", "DNA", "youtube"),
        ];

        let filtered = cands
            .iter()
            .filter(|c| exact_pair_match(&c.artist, &c.title, v_artist, v_title))
            .collect::<Vec<_>>();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].artist, "Kendrick Lamar");
        assert_eq!(filtered[0].title, "DNA.");
    }

    #[test]
    fn exact_pair_match_does_not_collapse_remix_into_original() {
        assert!(!exact_pair_match(
            "Artist A",
            "Song Name (ABC Remix)",
            "Artist A",
            "Song Name"
        ));
    }

    #[test]
    fn sanitize_title_with_artist_prefix() {
        let parsed = ParsedFilename {
            raw_stem: "Artist A - Track Z".into(),
            raw_lower: "artist a - track z".into(),
            clean_artist: "Artist A".into(),
            clean_title: "Track Z".into(),
            modifiers: Default::default(),
        };
        let mut c = mk_candidate("Artist A", "Artist A - Track Z", "itunes");
        sanitize_candidate_identity(&mut c, &parsed);
        assert_eq!(c.artist, "Artist A");
        assert_eq!(c.title, "Track Z");
    }

    #[test]
    fn sanitize_artist_with_compound_pair() {
        let parsed = ParsedFilename {
            raw_stem: "Artist B - Song Q".into(),
            raw_lower: "artist b - song q".into(),
            clean_artist: "Artist B".into(),
            clean_title: "Song Q".into(),
            modifiers: Default::default(),
        };
        let mut c = mk_candidate("Artist B - Song Q", "Song Q", "youtube");
        sanitize_candidate_identity(&mut c, &parsed);
        assert_eq!(c.artist, "Artist B");
        assert_eq!(c.title, "Song Q");
    }
}
