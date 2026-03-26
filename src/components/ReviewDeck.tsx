import { motion, useMotionValue, useTransform, animate } from "framer-motion";
import { memo, useEffect, useRef, useState } from "react";
import { previewRename, readEmbeddedCoverPreview } from "../api/tauri";
import type { RenameSettings } from "../options/types";
import type { ProposedTags, ReviewTrack, TagSnapshot } from "../types";
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
  /** Multi-source cover search; also runs automatically when no art exists yet. */
  onSearchNewCovers: () => void;
  /** User chose no cover for this path/match — skip auto cover lookup for it. */
  onDeclineAutoCoverSearch?: (path: string, candidateIndex: number) => void;
  rename: RenameSettings;
};

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
  return (
    <div className="field-row">
      <span className="field-label">{label}</span>
      <div className="field-cols">
        <div className="field-current" title="Current file tags">
          {current || "—"}
        </div>
        <input
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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        onAccept();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        onSkip();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onAccept, onSkip]);

  const n = track.candidates.length;
  const currentName = track.fileName || basename(track.path);
  const currentCandidate = track.candidates[track.candidateIndex];
  const coverOptions = currentCandidate?.coverOptions ?? [];

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
      <div className="review-card">
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

          <div className="card-cover">
            <img
              src={coverSrc}
              alt=""
              className="cover-img"
              onError={() => setCoverFailed(true)}
            />
          </div>

          <div className="card-path" title={track.path}>
            {track.path}
          </div>
        </motion.div>

        <div className="file-rename-block">
          <div className={`confidence-pill ${track.confidence}`}>
            {track.confidence === "high"
              ? "High confidence"
              : track.confidence === "medium"
                ? "Needs confirmation"
                : "Manual check"}
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
            <div className="row" style={{ marginTop: "0.4rem", marginBottom: "0.4rem" }}>
              <button type="button" className="btn btn-secondary" onClick={onSwapArtistTitle}>
                Swap artist/title
              </button>
            </div>
          )}
          <div className="file-rename-label">File name</div>
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
          <div className="cover-options-block">
            <div className="cover-options-title">Cover proposals</div>
            <p className="cover-options-hint">
              If this match has no art yet, extra sources are searched automatically.
              Use the button below to search again anytime.
            </p>
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
              <div className="muted" style={{ marginTop: "0.35rem" }}>
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
          <div className="row" style={{ marginTop: "0.45rem" }}>
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
            <div className="guess-chip-row" style={{ marginBottom: "0.35rem" }}>
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
            <div className="guess-chip-row" style={{ marginBottom: "0.35rem" }}>
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
      </div>
    </div>
  );
}

export const ReviewDeck = memo(ReviewDeckInner);
