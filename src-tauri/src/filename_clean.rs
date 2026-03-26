use regex::Regex;
use std::sync::OnceLock;

use crate::models::CleanedFilename;
use crate::options::CleaningOptions;

fn promo_parens_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\([^)]*(?:SkySound|\.cc|\.net|\.com|\.org|\.info)[^)]*\)").unwrap()
    })
}

fn multispace_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s+").unwrap())
}

fn source_tail_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)\s*(?:-\s*)?(?:\(?\s*(?:themp3(?:\.info)?|4djsonline|zippy|download)\s*\)?(?:\s*\([^)]*\))?)\s*$",
        )
        .unwrap()
    })
}

fn leading_prefix_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s*(?:\d{1,3}\s+){1,4}").unwrap())
}

fn noise_tail_re(o: &CleaningOptions) -> Option<Regex> {
    if !o.strip_noise_tokens {
        return None;
    }
    let mut parts = Vec::new();
    if o.noise_extended_mix {
        parts.push("Extended Mix");
        parts.push("Extended Version");
        parts.push("Extended");
    }
    if o.noise_vip {
        parts.push("VIP");
        parts.push("V\\.I\\.P\\.");
    }
    if o.noise_radio_edit {
        parts.push("Radio Edit");
        parts.push("Radio Mix");
    }
    if o.noise_bootleg {
        parts.push("Bootleg");
    }
    if o.noise_mashup {
        parts.push("Mashup");
    }
    if o.noise_remix_edit {
        parts.push("Original Mix");
        parts.push("Club Mix");
        parts.push("Dub Mix");
        parts.push("Instrumental");
        parts.push("Extended Edit");
        parts.push("Original Version");
        parts.push("Remix");
        parts.push("Edit");
        parts.push("Version");
        parts.push("Mix");
    }
    if parts.is_empty() {
        return None;
    }
    let alt = parts.join("|");
    let pat = format!(r"(?i)(?:\s*[\[\(]?(?:{alt})[\]\)]?)\s*$");
    Some(Regex::new(&pat).unwrap())
}

fn normalize_featuration(s: &str) -> String {
    let re_ft = OnceLock::new();
    let re_ft = re_ft.get_or_init(|| Regex::new(r"(?i)\bft\.").unwrap());
    let re_vs = OnceLock::new();
    let re_vs = re_vs.get_or_init(|| Regex::new(r"(?i)\bvs\.").unwrap());
    let mut t = re_ft.replace_all(s, "feat.").to_string();
    t = re_vs.replace_all(&t, "vs.").to_string();
    multispace_re().replace_all(t.trim(), " ").to_string()
}

fn strip_noise_end(s: &str, re: &Option<Regex>) -> String {
    let Some(re) = re else {
        return s.to_string();
    };
    let mut t = s.to_string();
    for _ in 0..8 {
        let next = re.replace_all(t.trim_end(), "").to_string();
        let next = next.trim_end().to_string();
        if next == t {
            break;
        }
        t = next;
    }
    t
}

fn structural_clean(stem: &str, o: &CleaningOptions) -> String {
    let mut s = stem.trim().to_string();
    if o.strip_promo_parens {
        s = promo_parens_re().replace_all(&s, "").to_string();
    }
    if o.underscores_to_spaces {
        s = s.replace('_', " ");
    }
    if o.collapse_whitespace {
        s = multispace_re().replace_all(s.trim(), " ").to_string();
    } else {
        s = s.trim().to_string();
    }
    s = source_tail_re().replace_all(&s, "").to_string();
    s = multispace_re().replace_all(s.trim(), " ").to_string();
    s
}

fn title_looks_spam(t: &str) -> bool {
    let tt = t.trim().to_lowercase();
    tt.contains(".info")
        || tt.contains(".com")
        || tt.contains("4djsonline")
        || tt.contains("themp3")
        || tt.contains("download")
}

fn split_artist_title(s: &str, rule: &str) -> (Option<String>, String) {
    let work = s.trim();
    let mut cands: Vec<(usize, String, String)> = Vec::new();
    for sep in [" - ", " — ", " – "] {
        if let Some((a, t)) = work.split_once(sep) {
            let a = a.trim();
            let t = t.trim();
            if !a.is_empty() && !t.is_empty() {
                cands.push((sep.len(), a.to_string(), t.to_string()));
            }
        }
        if let Some((a, t)) = work.rsplit_once(sep) {
            let a = a.trim();
            let t = t.trim();
            if !a.is_empty() && !t.is_empty() {
                cands.push((sep.len() + 10, a.to_string(), t.to_string()));
            }
        }
    }
    if cands.is_empty() {
        return (None, work.to_string());
    }
    let numeric_prefix = leading_prefix_re();
    let use_last = rule == "lastDash";
    cands.sort_by_key(|(k, _, _)| {
        if use_last {
            *k + 10
        } else {
            *k
        }
    });
    for (_, a, t) in cands {
        if title_looks_spam(&t) {
            continue;
        }
        let stripped = numeric_prefix.replace(&a, "").to_string();
        let candidate_artist = if stripped.trim().is_empty() {
            a
        } else {
            stripped.trim().to_string()
        };
        return (Some(candidate_artist), t);
    }
    (None, work.to_string())
}

/// Staged cleaning driven by [`CleaningOptions`].
pub fn clean_filename_stem(stem: &str, o: &CleaningOptions) -> CleanedFilename {
    let base = structural_clean(stem, o);
    let (artist_part, title_part) = split_artist_title(&base, &o.split_rule);

    let mut artist = artist_part.unwrap_or_default();
    let mut title = title_part;

    if o.normalize_feat {
        artist = normalize_featuration(&artist);
        title = normalize_featuration(&title);
    }

    let noise_re = noise_tail_re(o);

    let display_artist = artist.clone();
    let display_title = if o.strip_noise_tokens && !o.search_only_extra_strip {
        strip_noise_end(&title, &noise_re)
    } else {
        title.clone()
    };

    let search_artist = if o.strip_noise_tokens && !o.search_only_extra_strip {
        strip_noise_end(&artist, &noise_re)
    } else {
        artist.clone()
    };

    let search_title = if o.strip_noise_tokens {
        strip_noise_end(
            if o.search_only_extra_strip {
                &title
            } else {
                &display_title
            },
            &noise_re,
        )
    } else if o.search_only_extra_strip {
        strip_noise_end(&title, &noise_re)
    } else {
        display_title.clone()
    };

    let display = if display_artist.is_empty() {
        display_title.clone()
    } else {
        format!("{display_artist} — {display_title}")
    };

    CleanedFilename {
        display,
        search_artist: search_artist.trim().to_string(),
        search_title: search_title.trim().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts_default() -> CleaningOptions {
        CleaningOptions::default()
    }

    #[test]
    fn skysound_and_underscores() {
        let c = clean_filename_stem(
            "Luciid_-_Fxck_Devin_Wild_Edit_Extended_Mix_(SkySound.cc)",
            &opts_default(),
        );
        assert!(!c.search_title.to_lowercase().contains("skysound"));
        assert_eq!(c.search_artist, "Luciid");
    }

    #[test]
    fn simple_dash() {
        let c = clean_filename_stem("Sound Rush - Journey through sound", &opts_default());
        assert_eq!(c.search_artist, "Sound Rush");
        assert_eq!(c.search_title, "Journey through sound");
    }

    #[test]
    fn last_dash_split() {
        let mut o = opts_default();
        o.split_rule = "lastDash".into();
        let c = clean_filename_stem("Act A - Act B - Final Title", &o);
        assert_eq!(c.search_artist, "Act A - Act B");
        assert_eq!(c.search_title, "Final Title");
    }

    #[test]
    fn strips_prefix_and_source_suffix() {
        let c = clean_filename_stem(
            "19 26 Layla Benitez — All The Time Original Mix - 4DJSONLINE (TheMP3.Info)",
            &opts_default(),
        );
        assert_eq!(c.search_artist, "Layla Benitez");
        assert_eq!(c.search_title, "All The Time");
        assert!(!c.search_title.to_lowercase().contains("jsonline"));
        assert!(!c.search_title.to_lowercase().contains(".info"));
    }
}
