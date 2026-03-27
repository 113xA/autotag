use regex::Regex;
use std::collections::HashSet;
use std::sync::OnceLock;

use crate::models::LookupCandidate;

/// Modifier tags extracted from a filename during Phase 1 parsing.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilenameModifiers {
    pub is_remix: bool,
    pub remix_artist: Option<String>,
    pub is_live: bool,
    pub is_acoustic: bool,
    pub is_instrumental: bool,
    pub is_remaster: bool,
    pub is_radio_edit: bool,
    pub is_extended: bool,
    pub is_vip: bool,
    pub is_bootleg: bool,
    pub is_mashup: bool,
    pub feat_artists: Vec<String>,
}

/// The dual-state representation of a filename (Phase 1 output).
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedFilename {
    /// State A: raw stem with extension stripped, otherwise untouched.
    pub raw_stem: String,
    /// Lowercased raw stem for fast substring checks.
    pub raw_lower: String,
    /// State B: cleaned artist.
    pub clean_artist: String,
    /// State B: cleaned title (core, modifiers removed).
    pub clean_title: String,
    /// Structured modifiers extracted from the raw stem.
    pub modifiers: FilenameModifiers,
}

/// Breakdown of how a candidate was scored (for UI / debugging).
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreBreakdown {
    pub artist_baseline: f64,
    pub title_baseline: f64,
    pub context_bonus: f64,
    pub hallucination_penalty: f64,
    pub source_trust: f64,
    pub total: f64,
}

// ---------------------------------------------------------------------------
// Modifier extraction (Phase 1)
// ---------------------------------------------------------------------------

fn remix_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)[\(\[]([^)\]]*?)\s+(?:remix|rmx|rework|flip|bootleg\s+remix)[\)\]]")
            .unwrap()
    })
}

fn bare_remix_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\b(?:remix|rmx|rework|flip)\b").unwrap())
}

fn feat_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(?:\bfeat\.?\s*|\bft\.?\s*|\bfeaturing\s+)([^)\]\-]+)")
            .unwrap()
    })
}

pub fn extract_modifiers(raw_stem: &str) -> FilenameModifiers {
    let lower = raw_stem.to_lowercase();
    let mut m = FilenameModifiers::default();

    if let Some(caps) = remix_re().captures(raw_stem) {
        m.is_remix = true;
        let remixer = caps.get(1).map(|c| c.as_str().trim().to_string());
        if let Some(r) = remixer.filter(|r| !r.is_empty()) {
            m.remix_artist = Some(r);
        }
    } else if bare_remix_re().is_match(raw_stem) {
        m.is_remix = true;
    }

    m.is_live = lower.contains("live") && !lower.contains("alive");
    m.is_acoustic = lower.contains("acoustic");
    m.is_instrumental = lower.contains("instrumental");
    m.is_remaster = lower.contains("remaster");
    m.is_radio_edit =
        lower.contains("radio edit") || lower.contains("radio mix");
    m.is_extended =
        lower.contains("extended mix") || lower.contains("extended version")
            || lower.contains("extended edit");
    m.is_vip = Regex::new(r"(?i)\bvip\b").unwrap().is_match(&lower);
    m.is_bootleg = lower.contains("bootleg");
    m.is_mashup = lower.contains("mashup") || lower.contains("mash-up");

    for caps in feat_re().captures_iter(raw_stem) {
        if let Some(names) = caps.get(1) {
            for name in names.as_str().split(|c: char| c == ',' || c == '&') {
                let trimmed = name.trim();
                if !trimmed.is_empty() && trimmed.len() > 1 {
                    m.feat_artists.push(trimmed.to_string());
                }
            }
        }
    }

    m
}

// ---------------------------------------------------------------------------
// Fuzzy token matching
// ---------------------------------------------------------------------------

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

fn token_overlap(a: &str, b: &str) -> f64 {
    let a_toks = norm_tokens(a);
    let b_toks: HashSet<String> = norm_tokens(b).into_iter().collect();
    if a_toks.is_empty() {
        return 0.0;
    }
    let hits = a_toks.iter().filter(|t| b_toks.contains(t.as_str())).count();
    hits as f64 / a_toks.len() as f64
}

fn bidirectional_token_score(query: &str, candidate: &str) -> f64 {
    let fwd = token_overlap(query, candidate);
    let rev = token_overlap(candidate, query);
    fwd * 0.6 + rev * 0.4
}

// ---------------------------------------------------------------------------
// Bi-directional scoring (Phase 3)
// ---------------------------------------------------------------------------

/// Score a single API candidate against the dual-state parsed filename (0-100).
pub fn bidirectional_score(
    parsed: &ParsedFilename,
    candidate: &LookupCandidate,
    source_name: &str,
) -> (f64, ScoreBreakdown) {
    let mut bd = ScoreBreakdown::default();

    // --- 1. Baseline score (0-60) ---
    let artist_sim = bidirectional_token_score(&parsed.clean_artist, &candidate.artist);
    bd.artist_baseline = artist_sim * 30.0;

    let title_sim = bidirectional_token_score(&parsed.clean_title, &candidate.title);
    bd.title_baseline = title_sim * 30.0;

    // --- 2. Context bonus (0-25) ---
    let raw = &parsed.raw_lower;
    let mut ctx = 0.0_f64;

    if let Some(ref remix_artist) = parsed.modifiers.remix_artist {
        let remix_lower = remix_artist.to_lowercase();
        let cand_title_lower = candidate.title.to_lowercase();
        if cand_title_lower.contains(&remix_lower)
            || candidate.artist.to_lowercase().contains(&remix_lower)
        {
            ctx += 8.0;
        }
    }

    if !candidate.album.is_empty() {
        let album_toks = norm_tokens(&candidate.album);
        let raw_toks: HashSet<String> = norm_tokens(raw).into_iter().collect();
        let album_hits = album_toks.iter().filter(|t| raw_toks.contains(t.as_str())).count();
        if album_toks.len() > 0 && album_hits as f64 / album_toks.len() as f64 > 0.5 {
            ctx += 4.0;
        }
    }

    if let Some(y) = candidate.year {
        if raw.contains(&y.to_string()) {
            ctx += 4.0;
        }
    }

    for feat in &parsed.modifiers.feat_artists {
        let feat_lower = feat.to_lowercase();
        if candidate.artist.to_lowercase().contains(&feat_lower)
            || candidate.title.to_lowercase().contains(&feat_lower)
        {
            ctx += 4.0;
            break;
        }
    }

    bd.context_bonus = ctx.min(25.0);

    // --- 3. Hallucination penalty (-30 to 0) ---
    let mut penalty = 0.0_f64;
    let cand_lower = format!(
        "{} {}",
        candidate.artist.to_lowercase(),
        candidate.title.to_lowercase()
    );

    if (cand_lower.contains("live") && !cand_lower.contains("alive"))
        && !parsed.modifiers.is_live
    {
        penalty -= 15.0;
    }
    if cand_lower.contains("acoustic") && !parsed.modifiers.is_acoustic {
        penalty -= 12.0;
    }
    if (cand_lower.contains("remix") || cand_lower.contains("rmx"))
        && !parsed.modifiers.is_remix
    {
        penalty -= 10.0;
    }
    if cand_lower.contains("instrumental") && !parsed.modifiers.is_instrumental {
        penalty -= 8.0;
    }
    if cand_lower.contains("remaster") && !parsed.modifiers.is_remaster {
        penalty -= 5.0;
    }

    bd.hallucination_penalty = penalty.max(-30.0);

    // --- 4. Source trust bonus (0-15) ---
    let mb_score = candidate.score.unwrap_or(0) as f64;
    bd.source_trust = match source_name {
        "musicbrainz" => {
            if mb_score >= 90.0 { 15.0 }
            else if mb_score >= 70.0 { 12.0 }
            else { 8.0 }
        }
        "deezer" | "itunes" => 12.0,
        "discogs" => 10.0,
        "spotify" => 8.0,
        "youtube" => 6.0,
        _ => 5.0,
    };

    // --- Final ---
    bd.total = (bd.artist_baseline + bd.title_baseline + bd.context_bonus
        + bd.hallucination_penalty + bd.source_trust)
        .clamp(0.0, 100.0);

    (bd.total, bd)
}

/// Score a candidate using legacy stem-overlap (for backwards compat in places
/// where we don't yet have a full ParsedFilename).
pub fn legacy_relevance_score(stem: &str, c: &LookupCandidate) -> f64 {
    let parsed = ParsedFilename {
        raw_stem: stem.to_string(),
        raw_lower: stem.to_lowercase(),
        clean_artist: String::new(),
        clean_title: String::new(),
        modifiers: extract_modifiers(stem),
    };
    let stem_toks = norm_tokens(stem);
    if stem_toks.is_empty() {
        return 0.0;
    }
    let pool = format!(
        "{} {}",
        norm_tokens(&c.artist).join(" "),
        norm_tokens(&c.title).join(" ")
    );
    let overlap = stem_toks.iter().filter(|t| pool.contains(t.as_str())).count() as f64
        / stem_toks.len() as f64;

    let source = candidate_source_weight(c);
    let noise = title_noise_penalty(&c.title);
    let hallucination = hallucination_penalty_quick(&parsed, c);

    (overlap * 0.60 + source * 0.18 + hallucination * 0.12 - noise).clamp(0.0, 1.0)
}

fn candidate_source_weight(c: &LookupCandidate) -> f64 {
    if c.cover_options.iter().any(|o| o.source == "deezer") {
        1.0
    } else if c.cover_options.iter().any(|o| o.source == "itunes") {
        0.92
    } else if c.cover_options.iter().any(|o| o.source == "discogs") {
        0.85
    } else if c.cover_options.iter().any(|o| o.source == "youtube") {
        0.80
    } else if c.cover_options.iter().any(|o| o.source == "spotify") {
        0.72
    } else {
        0.70
    }
}

fn title_noise_penalty(title: &str) -> f64 {
    let t = title.to_lowercase();
    if t.contains(".info") || t.contains("download") || t.contains("jsonline") {
        0.25
    } else {
        0.0
    }
}

fn hallucination_penalty_quick(parsed: &ParsedFilename, c: &LookupCandidate) -> f64 {
    let cand = format!("{} {}", c.artist, c.title).to_lowercase();
    let mut p = 0.0_f64;
    if cand.contains("live") && !cand.contains("alive") && !parsed.modifiers.is_live {
        p -= 0.15;
    }
    if cand.contains("acoustic") && !parsed.modifiers.is_acoustic {
        p -= 0.12;
    }
    if (cand.contains("remix") || cand.contains("rmx")) && !parsed.modifiers.is_remix {
        p -= 0.10;
    }
    if cand.contains("instrumental") && !parsed.modifiers.is_instrumental {
        p -= 0.08;
    }
    p.max(-0.30)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CoverOption, LookupCandidate};

    fn mk_cand(artist: &str, title: &str, source: &str) -> LookupCandidate {
        LookupCandidate {
            recording_mbid: String::new(),
            release_mbid: String::new(),
            artist: artist.to_string(),
            title: title.to_string(),
            album: String::new(),
            album_artist: None,
            track_number: None,
            year: None,
            cover_url: None,
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
    fn extracts_remix_artist() {
        let m = extract_modifiers("The Weeknd - Blinding Lights (Chromatics Remix)");
        assert!(m.is_remix);
        assert_eq!(m.remix_artist.as_deref(), Some("Chromatics"));
    }

    #[test]
    fn extracts_bare_remix() {
        let m = extract_modifiers("Artist - Track Remix");
        assert!(m.is_remix);
        assert!(m.remix_artist.is_none());
    }

    #[test]
    fn extracts_live_not_alive() {
        let m = extract_modifiers("Daft Punk - Alive 2007");
        assert!(!m.is_live);
        let m2 = extract_modifiers("Nirvana - Smells Like Teen Spirit (Live)");
        assert!(m2.is_live);
    }

    #[test]
    fn extracts_feat_artists() {
        let m = extract_modifiers("DJ Snake feat. Lil Jon - Turn Down for What");
        assert_eq!(m.feat_artists, vec!["Lil Jon"]);
    }

    #[test]
    fn correct_match_scores_high() {
        let parsed = ParsedFilename {
            raw_stem: "The Weeknd - Blinding Lights".into(),
            raw_lower: "the weeknd - blinding lights".into(),
            clean_artist: "The Weeknd".into(),
            clean_title: "Blinding Lights".into(),
            modifiers: FilenameModifiers::default(),
        };
        let cand = mk_cand("The Weeknd", "Blinding Lights", "deezer");
        let (score, _) = bidirectional_score(&parsed, &cand, "deezer");
        assert!(score >= 60.0, "expected >= 60, got {score}");
    }

    #[test]
    fn hallucination_live_penalised() {
        let parsed = ParsedFilename {
            raw_stem: "Artist - Song".into(),
            raw_lower: "artist - song".into(),
            clean_artist: "Artist".into(),
            clean_title: "Song".into(),
            modifiers: FilenameModifiers::default(),
        };
        let live = mk_cand("Artist", "Song (Live)", "deezer");
        let normal = mk_cand("Artist", "Song", "deezer");
        let (s_live, _) = bidirectional_score(&parsed, &live, "deezer");
        let (s_normal, _) = bidirectional_score(&parsed, &normal, "deezer");
        assert!(s_normal > s_live, "normal {s_normal} should beat live {s_live}");
    }

    #[test]
    fn remix_context_bonus_applied() {
        let parsed = ParsedFilename {
            raw_stem: "The Weeknd - Blinding Lights (Chromatics Remix)".into(),
            raw_lower: "the weeknd - blinding lights (chromatics remix)".into(),
            clean_artist: "The Weeknd".into(),
            clean_title: "Blinding Lights".into(),
            modifiers: FilenameModifiers {
                is_remix: true,
                remix_artist: Some("Chromatics".into()),
                ..Default::default()
            },
        };
        let with = mk_cand("The Weeknd", "Blinding Lights (Chromatics Remix)", "deezer");
        let without = mk_cand("The Weeknd", "Blinding Lights", "deezer");
        let (s_with, _) = bidirectional_score(&parsed, &with, "deezer");
        let (s_without, _) = bidirectional_score(&parsed, &without, "deezer");
        assert!(s_with > s_without, "with remix {s_with} should beat without {s_without}");
    }

    #[test]
    fn wrong_remix_penalised() {
        let parsed = ParsedFilename {
            raw_stem: "Artist - Song".into(),
            raw_lower: "artist - song".into(),
            clean_artist: "Artist".into(),
            clean_title: "Song".into(),
            modifiers: FilenameModifiers::default(),
        };
        let remix = mk_cand("Artist", "Song (DJ X Remix)", "deezer");
        let normal = mk_cand("Artist", "Song", "deezer");
        let (s_remix, _) = bidirectional_score(&parsed, &remix, "deezer");
        let (s_normal, _) = bidirectional_score(&parsed, &normal, "deezer");
        assert!(s_normal > s_remix, "normal {s_normal} should beat wrong remix {s_remix}");
    }
}
