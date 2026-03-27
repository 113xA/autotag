import {
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
  animate,
} from "framer-motion";
import { memo, useEffect, useRef, useState } from "react";
import { previewRename, readEmbeddedCoverPreview } from "../api/tauri";
import type { RenameSettings } from "../options/types";
import type {
  FilenameModifiers,
  ParsedFilename,
  ProposedTags,
  ReviewTrack,
  TagSnapshot,
} from "../types";
import { parseU32 } from "../utils/parse";

const PLACEHOLDER_COVER = "/placeholder-cover.svg";

type Props = {
  track: ReviewTrack;
  proposed: ProposedTags;
  coverSearchActive: boolean;
  coverSearchCount: number;
  coverSearchTotal: number;
  onProposedChange: (p: ProposedTags) => void;
  onPrevCandidate: () => void;
  onNextCandidate: () => void;
  onAccept: () => void;
  onSkip: () => void;
  onGuessArtist: (artist: string) => void;
  onSwapArtistTitle: () => void;
  onMusicbrainzLookup: () => void;
  onSearchNewCovers: () => void;
  onDeclineAutoCoverSearch?: (path: string, candidateIndex: number) => void;
  rename: RenameSettings;
};

function confidenceBarColor(score: number): string {
  if (score >= 80) return "var(--good)";
  if (score >= 50) return "var(--warn)";
  return "var(--bad)";
}

function basename(p: string): string {
  const s = p.replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

function Field({
  label,
  current,
  proposed,
  onChange,
  name,
}: {
  label: string;
  current: string;
  proposed: string;
  onChange: (v: string) => void;
  name: string;
}) {
  const inputId = `field-proposed-${name}`;
  return (
    <div className="field-row">
      <label htmlFor={inputId} className="field-label">{label}</label>
      <div className="field-cols">
        <div className="field-current" title="Current file tags">
          {current || "—"}
        </div>
        <input
          id={inputId}
          className="field-proposed"
          name={name}
          value={proposed}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />
      </div>
    </div>
  );
}

function fmtCurrent(t: TagSnapshot, key: keyof TagSnapshot): string {
  const v = t[key];
  if (v === null || v === undefined) return "";
  return String(v);
}

function dualStateFromTrack(track: ReviewTrack): ParsedFilename {
  const p = track.parsed;
  if (p) return p;
  return {
    rawStem: track.filenameStem,
    rawLower: track.filenameStem.toLowerCase(),
    cleanArtist: track.cleaned.searchArtist,
    cleanTitle: track.cleaned.searchTitle,
    modifiers: {
      isRemix: false,
      remixArtist: null,
      isLive: false,
      isAcoustic: false,
      isInstrumental: false,
      isRemaster: false,
      isRadioEdit: false,
      isExtended: false,
      isVip: false,
      isBootleg: false,
      isMashup: false,
      featArtists: [],
    },
  };
}

function formatModifiersList(m: FilenameModifiers): string {
  const parts: string[] = [];
  if (m.remixArtist?.trim()) parts.push(`remix: ${m.remixArtist.trim()}`);
  else if (m.isRemix) parts.push("remix");
  if (m.featArtists.length > 0) {
    parts.push(`feat: ${m.featArtists.join(", ")}`);
  }
  if (m.isLive) parts.push("live");
  if (m.isAcoustic) parts.push("acoustic");
  if (m.isInstrumental) parts.push("instrumental");
  if (m.isRemaster) parts.push("remaster");
  if (m.isRadioEdit) parts.push("radio edit");
  if (m.isExtended) parts.push("extended");
  if (m.isVip) parts.push("VIP");
  if (m.isBootleg) parts.push("bootleg");
  if (m.isMashup) parts.push("mashup");
  return parts.length > 0 ? parts.join(" · ") : "";
}

function ReviewDeckInner({
  track,
  proposed,
  coverSearchActive,
  coverSearchCount,
  coverSearchTotal,
  onProposedChange,
  onPrevCandidate,
  onNextCandidate,
  onAccept,
  onSkip,
  onGuessArtist,
  onSwapArtistTitle,
  onMusicbrainzLookup,
  onSearchNewCovers,
  onDeclineAutoCoverSearch,
  rename,
}: Props) {
  const reduceMotion = useReducedMotion();
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-200, 200], [-8, 8]);
  const acceptOpacity = useTransform(x, [0, 80], [0, 1]);
  const skipOpacity = useTransform(x, [-80, 0], [1, 0]);

  const [newNamePreview, setNewNamePreview] = useState<string | null>(null);
  const [coverFailed, setCoverFailed] = useState(false);
  const [embeddedPreviewUrl, setEmbeddedPreviewUrl] = useState<string | null>(
    null,
  );
  const userChoseNoCoverRef = useRef(false);

  useEffect(() => {
    x.set(0);
  }, [track.path, track.candidateIndex, x]);

  useEffect(() => {
    userChoseNoCoverRef.current = false;
  }, [track.path, track.candidateIndex]);

  useEffect(() => {
    setCoverFailed(false);
  }, [proposed.coverUrl]);

  useEffect(() => {
    if (proposed.coverUrl?.trim()) userChoseNoCoverRef.current = false;
  }, [proposed.coverUrl]);

  const renamePreviewDebounceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!rename.enabled) {
      setNewNamePreview(null);
      return;
    }
    const a = proposed.artist.trim();
    const t = proposed.title.trim();
    const album = proposed.album.trim();
    const year = parseU32(proposed.year);
    if (!a && !t && !album) {
      setNewNamePreview(null);
      return;
    }
    let cancel = false;
    if (renamePreviewDebounceRef.current !== null) {
      window.clearTimeout(renamePreviewDebounceRef.current);
    }
    renamePreviewDebounceRef.current = window.setTimeout(() => {
      void previewRename(track.path, a, t, album, year, rename)
        .then((nm) => {
          if (!cancel) setNewNamePreview(nm);
        })
        .catch(() => {
          if (!cancel) setNewNamePreview(null);
        });
    }, 300);
    return () => {
      cancel = true;
      if (renamePreviewDebounceRef.current !== null) {
        window.clearTimeout(renamePreviewDebounceRef.current);
      }
    };
  }, [
    rename.enabled,
    rename.includeArtist,
    rename.includeTitle,
    rename.includeAlbum,
    rename.includeYear,
    rename.separator,
    rename.partOrder,
    track.path,
    proposed.artist,
    proposed.title,
    proposed.album,
    proposed.year,
  ]);

  const n = track.candidates.length;
  const currentName = track.fileName || basename(track.path);
  const currentCandidate = track.candidates[track.candidateIndex];
  const coverOptions = currentCandidate?.coverOptions ?? [];
  const dual = dualStateFromTrack(track);
  const modifiersLine = formatModifiersList(dual.modifiers);
  const topRanked = track.candidates[0];

  useEffect(() => {
    if (!track.current.hasEmbeddedCover || proposed.explicitlyNoCover) {
      setEmbeddedPreviewUrl(null);
      return;
    }
    if (
      proposed.coverUrl?.trim() ||
      currentCandidate?.coverUrl?.trim() ||
      coverOptions.length > 0
    ) {
      setEmbeddedPreviewUrl(null);
      return;
    }
    let cancelled = false;
    void readEmbeddedCoverPreview(track.path).then((url) => {
      if (!cancelled) setEmbeddedPreviewUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [
    track.path,
    track.candidateIndex,
    proposed.coverUrl,
    proposed.explicitlyNoCover,
    track.current.hasEmbeddedCover,
    currentCandidate?.coverUrl,
    coverOptions.length,
  ]);

  const albumSuggestions = Array.from(
    new Set(
      track.candidates
        .map((c) => c.album.trim())
        .filter((a) => a.length > 0),
    ),
  ).slice(0, 6);
  const yearSuggestions = Array.from(
    new Set(
      track.candidates
        .map((c) => (c.year != null ? String(c.year) : ""))
        .filter((y) => y.length > 0),
    ),
  ).slice(0, 6);

  // Keep showing existing art: proposed URL, embedded file art, else candidate / options,
  // unless the user explicitly chose "None (remove cover)" for this track/match.
  const heroCoverUrl =
    proposed.explicitlyNoCover || userChoseNoCoverRef.current
      ? null
      : proposed.coverUrl?.trim()
        ? proposed.coverUrl
        : embeddedPreviewUrl?.trim()
          ? embeddedPreviewUrl
          : currentCandidate?.coverUrl?.trim() ||
            coverOptions[0]?.url ||
            null;
  const coverSrc =
    !heroCoverUrl || coverFailed ? PLACEHOLDER_COVER : heroCoverUrl;
  const [coverExpanded, setCoverExpanded] = useState(false);

  useEffect(() => {
    setCoverExpanded(false);
  }, [track.path, track.candidateIndex]);

  const hasAnyCoverArt =
    Boolean(proposed.coverUrl?.trim()) ||
    Boolean(embeddedPreviewUrl?.trim()) ||
    Boolean(
      track.current.hasEmbeddedCover &&
        !proposed.explicitlyNoCover &&
        !userChoseNoCoverRef.current,
    ) ||
    Boolean(currentCandidate?.coverUrl?.trim()) ||
    coverOptions.length > 0;

  async function handleDragEnd(_: unknown, info: { offset: { x: number } }) {
    const dx = info.offset.x;
    if (dx > 100) {
      await animate(x, 400, { duration: 0.2 });
      onAccept();
      x.set(0);
      return;
    }
    if (dx < -100) {
      await animate(x, -400, { duration: 0.2 });
      onSkip();
      x.set(0);
      return;
    }
    animate(x, 0, { type: "spring", stiffness: 500, damping: 35 });
  }

  const cur = track.current;

  return (
    <div className="deck-wrap">
      <div className="deck-hint deck-hint-pill">
        Drag right to accept, left to skip — or use Arrow Right / Arrow Left.
      </div>
      <motion.div
        className="review-card"
        key={`${track.path}-${track.candidateIndex}`}
        initial={reduceMotion ? false : { opacity: 0, y: 16, scale: 0.988 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
      >
        <motion.div
          className="card-swipe-surface"
          style={{ x, rotate }}
          drag="x"
          dragConstraints={{ left: -220, right: 220 }}
          dragElastic={0.65}
          onDragEnd={handleDragEnd}
        >
          <motion.div className="swipe-badge accept" style={{ opacity: acceptOpacity }}>
            Apply
          </motion.div>
          <motion.div className="swipe-badge skip" style={{ opacity: skipOpacity }}>
            Skip
          </motion.div>

          <div className="card-path" title={track.path}>
            {track.path}
          </div>
        </motion.div>

        <div className="file-rename-block">
          <div className="lookup-search-basis">
            <div className="lookup-search-basis-title">Filename lookup basis</div>
            <p className="lookup-search-basis-lead muted">
              Matches are found with a two-pass flow: tolerant APIs query{" "}
              <strong>State A</strong> (raw stem); MusicBrainz / strict fallbacks use{" "}
              <strong>State B</strong> (clean artist + title). Ranking uses State B plus
              context from State A (not the display-only cleaned label).
            </p>
            <dl className="lookup-search-dl">
              <dt>State A — raw stem</dt>
              <dd>
                <code className="mono lookup-search-code">{dual.rawStem || "—"}</code>
              </dd>
              <dt>State B — clean query</dt>
              <dd>
                <code className="mono lookup-search-code">
                  {dual.cleanArtist || "—"} — {dual.cleanTitle || "—"}
                </code>
              </dd>
              {modifiersLine ? (
                <>
                  <dt>Modifiers (from filename)</dt>
                  <dd className="lookup-search-modifiers">{modifiersLine}</dd>
                </>
              ) : null}
              {topRanked && n > 0 ? (
                <>
                  <dt>Top ranked match</dt>
                  <dd>
                    <code className="mono lookup-search-code">
                      {topRanked.artist} — {topRanked.title}
                    </code>
                    {topRanked.score != null ? (
                      <span className="muted lookup-search-note">
                        {" "}
                        · score {Math.round(topRanked.score)}
                      </span>
                    ) : null}
                    {currentCandidate && currentCandidate !== topRanked ? (
                      <span className="muted lookup-search-note">
                        {" "}
                        (viewing match {track.candidateIndex + 1} of {n})
                      </span>
                    ) : null}
                  </dd>
                </>
              ) : null}
            </dl>
          </div>
          <div className="confidence-row">
            <div className={`confidence-pill ${track.confidence}`}>
              {track.confidence === "high"
                ? "High confidence"
                : track.confidence === "medium"
                  ? "Needs confirmation"
                  : "Manual check"}
            </div>
            <div className="confidence-bar-wrap" title={`Confidence: ${track.confidenceScore}%`}>
              <div
                className="confidence-bar-fill"
                style={{
                  width: `${track.confidenceScore}%`,
                  backgroundColor: confidenceBarColor(track.confidenceScore),
                }}
              />
              <span className="confidence-bar-label">{track.confidenceScore}%</span>
            </div>
          </div>
          {track.confidence === "medium" && track.artistGuesses.length > 0 && (
            <div className="guess-chip-row">
              {track.artistGuesses.slice(0, 4).map((g) => (
                <button
                  key={g}
                  type="button"
                  className="guess-chip"
                  onClick={() => onGuessArtist(g)}
                >
                  {g}
                </button>
              ))}
            </div>
          )}
          {track.confidence === "low" && (
            <div className="row low-confidence-actions">
              <button type="button" className="btn btn-secondary" onClick={onSwapArtistTitle}>
                Swap artist/title
              </button>
            </div>
          )}
          <div className="file-rename-label">Rename on disk (from proposed tags)</div>
          <p className="lookup-search-basis-hint muted">
            This preview uses the artist/title fields below after you accept — not the
            short “cleaned display” string from scan.
          </p>
          <div className="file-rename-row">
            <code className="mono name-old">{currentName}</code>
            <span className="file-rename-arrow">→</span>
            {rename.enabled ? (
              <code className="mono name-new">
                {newNamePreview ?? "…"}
              </code>
            ) : (
              <span className="muted">Unchanged (enable rename in settings)</span>
            )}
          </div>
          <div className="cover-section-row">
          <div className="cover-thumb-wrap">
            <img
              src={coverSrc}
              alt=""
              className="cover-thumb-img"
              onError={() => setCoverFailed(true)}
            />
            <button
              type="button"
              className="cover-expand-btn"
              onClick={() => setCoverExpanded(true)}
              title="View full size"
              aria-label="Expand cover art"
            >
              ⤢
            </button>
          </div>
          <div className="cover-options-block">
            <div className="cover-options-title">Cover proposals</div>
            <div className="row cover-actions-row">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onSearchNewCovers}
                disabled={coverSearchActive}
                title="Look up more cover art from your enabled sources"
              >
                {hasAnyCoverArt ? "Search new covers" : "Search for covers"}
              </button>
              <button
                type="button"
                className={`btn btn-secondary ${proposed.coverUrl ? "" : "selected"}`}
                onClick={() => {
                  userChoseNoCoverRef.current = true;
                  onDeclineAutoCoverSearch?.(track.path, track.candidateIndex);
                  onProposedChange({
                    ...proposed,
                    coverUrl: null,
                    explicitlyNoCover: true,
                  });
                }}
                title="Use no cover for this track"
              >
                None (remove cover)
              </button>
            </div>
            {coverOptions.length > 0 ? (
              <div className="cover-options-grid">
                {coverOptions.slice(0, 4).map((opt) => {
                  const selected = proposed.coverUrl === opt.url;
                  return (
                    <button
                      key={`${opt.source}-${opt.url}`}
                      type="button"
                      className={`cover-option-tile ${selected ? "selected" : ""}`}
                      onClick={() =>
                        onProposedChange({
                          ...proposed,
                          coverUrl: opt.url,
                          explicitlyNoCover: false,
                        })
                      }
                      title={`${opt.source}${opt.score != null ? ` (${(opt.score * 100).toFixed(0)}%)` : ""}`}
                    >
                      <img src={opt.url} alt="" onError={() => undefined} />
                      <span>{opt.source}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="muted cover-no-results">
                {coverSearchActive ? "Searching for covers..." : "No covers found yet"}
              </div>
            )}
            {coverSearchActive && (
              <div className="cover-search-status" role="status" aria-live="polite">
                <span className="cover-search-spinner" aria-hidden="true" />
                Searching covers... {Math.min(coverSearchCount, coverSearchTotal)} / {coverSearchTotal}
              </div>
            )}
            {coverSearchActive && (
              <progress
                className="lookup-progress-bar"
                max={coverSearchTotal}
                value={Math.min(coverSearchCount, coverSearchTotal)}
                aria-label="Current track cover progress"
              />
            )}
          </div>
          </div>
          {coverExpanded && (
            <div className="cover-lightbox" onClick={() => setCoverExpanded(false)}>
              <div className="cover-lightbox-inner" onClick={(e) => e.stopPropagation()}>
                <img src={coverSrc} alt="Cover art full size" />
                <button
                  type="button"
                  className="cover-lightbox-close"
                  onClick={() => setCoverExpanded(false)}
                  aria-label="Close expanded cover"
                >
                  ✕
                </button>
              </div>
            </div>
          )}
          <div className="row low-confidence-actions">
            <button type="button" className="btn btn-secondary" onClick={onMusicbrainzLookup}>
              MusicBrainz
            </button>
          </div>
        </div>

        {n > 1 && (
          <div className="candidate-nav">
            <button type="button" onClick={onPrevCandidate}>
              ‹ Prev match
            </button>
            <span>
              Match {track.candidateIndex + 1} / {n}
            </span>
            <button type="button" onClick={onNextCandidate}>
              Next match ›
            </button>
          </div>
        )}

        <div className="compare-grid">
          {albumSuggestions.length > 0 && (
            <div className="guess-chip-row chip-row-gap">
              {albumSuggestions.map((album) => (
                <button
                  key={`album-${album}`}
                  type="button"
                  className="guess-chip"
                  onClick={() => onProposedChange({ ...proposed, album })}
                >
                  Album: {album}
                </button>
              ))}
            </div>
          )}
          {yearSuggestions.length > 0 && (
            <div className="guess-chip-row chip-row-gap">
              {yearSuggestions.map((year) => (
                <button
                  key={`year-${year}`}
                  type="button"
                  className="guess-chip"
                  onClick={() => onProposedChange({ ...proposed, year })}
                >
                  Year: {year}
                </button>
              ))}
            </div>
          )}
          <div className="compare-head">
            <span>Field</span>
            <span>Current</span>
            <span>Proposed</span>
          </div>
          <Field
            label="Title"
            current={fmtCurrent(cur, "title")}
            proposed={proposed.title}
            onChange={(title) => onProposedChange({ ...proposed, title })}
            name="title"
          />
          <Field
            label="Artist"
            current={fmtCurrent(cur, "artist")}
            proposed={proposed.artist}
            onChange={(artist) => onProposedChange({ ...proposed, artist })}
            name="artist"
          />
          <Field
            label="Album"
            current={fmtCurrent(cur, "album")}
            proposed={proposed.album}
            onChange={(album) => onProposedChange({ ...proposed, album })}
            name="album"
          />
          <Field
            label="Album artist"
            current={fmtCurrent(cur, "albumArtist")}
            proposed={proposed.albumArtist}
            onChange={(albumArtist) =>
              onProposedChange({ ...proposed, albumArtist })
            }
            name="albumArtist"
          />
          <Field
            label="Track #"
            current={fmtCurrent(cur, "trackNumber")}
            proposed={proposed.trackNumber}
            onChange={(trackNumber) =>
              onProposedChange({ ...proposed, trackNumber })
            }
            name="trackNumber"
          />
          <Field
            label="Year"
            current={fmtCurrent(cur, "year")}
            proposed={proposed.year}
            onChange={(year) => onProposedChange({ ...proposed, year })}
            name="year"
          />
        </div>

        <div className="card-actions">
          <button type="button" className="btn skip-btn" onClick={onSkip}>
            Skip
          </button>
          <button type="button" className="btn accept-btn" onClick={onAccept}>
            Accept
          </button>
        </div>
      </motion.div>
    </div>
  );
}

export const ReviewDeck = memo(ReviewDeckInner);
