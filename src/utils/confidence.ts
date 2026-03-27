import type { ReviewTrack } from "../types";

const CONFIDENCE_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "ft",
  "feat",
  "featuring",
  "with",
  "from",
  "into",
  "of",
  "la",
  "le",
  "el",
  "der",
  "und",
  "im",
  "il",
  "i",
  "o",
  "e",
]);

function normalizeForFilename(s: string): string {
  return s
    .trim()
    .toLowerCase()
    // Common punctuation in releases/names:
    .replace(/['’]/g, "")
    .replace(/&/g, " and ")
    // Collapse everything else to spaces so '-' '_' '.' etc match.
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeForFilename(s: string): string[] {
  const n = normalizeForFilename(s);
  if (!n) return [];
  return n
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !CONFIDENCE_STOPWORDS.has(t));
}

function allTokensPresent(haystack: string, tokens: string[]): boolean {
  return (
    tokens.length > 0 && tokens.every((t) => t.length > 0 && haystack.includes(t))
  );
}

function splitArtistAlternatives(s: string): string[] {
  // Treat multi-artist strings as *alternatives* (not a single concatenated artist),
  // so a filename that only contains one of the artists can still score as a perfect match.
  // Examples: "Dom Dolla & MK", "Artist1, Artist2", "Artist1 feat. Artist2", "A x B".
  const replaced = s
    .trim()
    .replace(/\s*;\s*/g, ", ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+x\s+/gi, ", ")
    .replace(/\s*&\s+/gi, ", ")
    .replace(/\s+and\s+/gi, ", ")
    .replace(/\s+feat\.?\s+/gi, ", ")
    .replace(/\s+ft\.?\s+/gi, ", ");

  const parts = replaced
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  // Deduplicate after normalization.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const key = normalizeForFilename(p);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export function computeConfidenceScore(
  confidence: ReviewTrack["confidence"],
  candidates: ReviewTrack["candidates"],
  baseFileNameStem?: string,
): number {
  if (candidates.length === 0) return 0;

  const top = candidates[0];

  // Boost: if the filename already contains the *artist + title* (base name without extension),
  // treat it as a perfect match.
  if (baseFileNameStem) {
    const fn = normalizeForFilename(baseFileNameStem);

    const titleTokens = tokenizeForFilename(top.title ?? "");
    if (titleTokens.length > 0 && allTokensPresent(fn, titleTokens)) {
      const artistAlternatives = splitArtistAlternatives(top.artist ?? "");
      if (artistAlternatives.length > 0) {
        for (const alt of artistAlternatives) {
          const altTokens = tokenizeForFilename(alt);
          if (allTokensPresent(fn, altTokens)) {
            return 100;
          }
        }
      }

      // Fallback: require tokens from the full (possibly multi-artist) string.
      const artistTokens = tokenizeForFilename(top.artist ?? "");
      if (allTokensPresent(fn, artistTokens)) return 100;
    }
  }

  const baseFromLevel =
    confidence === "high" ? 75 : confidence === "medium" ? 40 : 10;
  const topScore = top.score != null ? Math.min(top.score, 100) : 0;

  const hasCover = Boolean(
    top.coverUrl?.trim() || (top.coverOptions?.length ?? 0) > 0,
  );
  const coverBonus = hasCover ? 8 : 0;
  const hasAlbum = Boolean(top.album?.trim());
  const albumBonus = hasAlbum ? 4 : 0;
  const hasYear = top.year != null;
  const yearBonus = hasYear ? 3 : 0;

  const raw = baseFromLevel + topScore * 0.1 + coverBonus + albumBonus + yearBonus;
  return Math.min(100, Math.max(0, Math.round(raw)));
}

