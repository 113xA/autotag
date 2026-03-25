use serde::{Deserialize, Serialize};

/// Filename / search-string cleaning (EDM-focused defaults in TS presets).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleaningOptions {
    pub strip_promo_parens: bool,
    pub underscores_to_spaces: bool,
    pub collapse_whitespace: bool,
    /// Strip common DJ mix tokens from search strings (and display if search_only_extra_strip false).
    pub strip_noise_tokens: bool,
    pub noise_extended_mix: bool,
    pub noise_vip: bool,
    pub noise_radio_edit: bool,
    pub noise_bootleg: bool,
    pub noise_mashup: bool,
    /// Strip trailing "Remix" / "Edit" style tokens (heuristic).
    pub noise_remix_edit: bool,
    pub normalize_feat: bool,
    /// "firstDash" | "lastDash"
    pub split_rule: String,
    /// If true, noise stripping only affects search_artist/search_title, not display string.
    pub search_only_extra_strip: bool,
}

impl Default for CleaningOptions {
    fn default() -> Self {
        Self {
            strip_promo_parens: true,
            underscores_to_spaces: true,
            collapse_whitespace: true,
            strip_noise_tokens: true,
            noise_extended_mix: true,
            noise_vip: true,
            noise_radio_edit: true,
            noise_bootleg: true,
            noise_mashup: true,
            noise_remix_edit: true,
            normalize_feat: true,
            split_rule: "firstDash".into(),
            search_only_extra_strip: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchingOptions {
    pub limit: u8,
    /// Appended as ` AND (...)` to the Lucene query; empty = off.
    pub tag_bias: String,
    pub fallback_recording_only: bool,
    /// Second pass: shorter title (strip parenthetical segments).
    pub fallback_strip_parens: bool,
}

impl Default for MatchingOptions {
    fn default() -> Self {
        Self {
            limit: 8,
            tag_bias: String::new(),
            fallback_recording_only: true,
            fallback_strip_parens: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyMetadataOptions {
    pub write_tags: bool,
    pub embed_cover: bool,
    pub genre: Option<String>,
    pub grouping: Option<String>,
    pub comment: Option<String>,
}

impl Default for ApplyMetadataOptions {
    fn default() -> Self {
        Self {
            write_tags: true,
            embed_cover: true,
            genre: None,
            grouping: None,
            comment: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub kind: String,
    pub done: u32,
    pub total: u32,
    pub message: Option<String>,
}
