import { motion, useMotionValue, useTransform, animate } from "framer-motion";
import { useEffect, useState } from "react";
import { previewRename } from "../api/tauri";
import type { RenameSettings } from "../options/types";
import type { ProposedTags, ReviewTrack, TagSnapshot } from "../types";

const PLACEHOLDER_COVER = "/placeholder-cover.svg";

type Props = {
  track: ReviewTrack;
  proposed: ProposedTags;
  onProposedChange: (p: ProposedTags) => void;
  onPrevCandidate: () => void;
  onNextCandidate: () => void;
  onAccept: () => void;
  onSkip: () => void;
  rename: RenameSettings;
};

function basename(p: string): string {
  const s = p.replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

function parseYear(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  if (!/^\d{1,9}$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
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

export function ReviewDeck({
  track,
  proposed,
  onProposedChange,
  onPrevCandidate,
  onNextCandidate,
  onAccept,
  onSkip,
  rename,
}: Props) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-200, 200], [-8, 8]);
  const acceptOpacity = useTransform(x, [0, 80], [0, 1]);
  const skipOpacity = useTransform(x, [-80, 0], [1, 0]);

  const [newNamePreview, setNewNamePreview] = useState<string | null>(null);
  const [coverFailed, setCoverFailed] = useState(false);

  useEffect(() => {
    x.set(0);
  }, [track.path, track.candidateIndex, x]);

  useEffect(() => {
    setCoverFailed(false);
  }, [proposed.coverUrl]);

  useEffect(() => {
    if (!rename.enabled) {
      setNewNamePreview(null);
      return;
    }
    const a = proposed.artist.trim();
    const t = proposed.title.trim();
    const album = proposed.album.trim();
    const year = parseYear(proposed.year);
    if (!a && !t && !album) {
      setNewNamePreview(null);
      return;
    }
    let cancel = false;
    previewRename(track.path, a, t, album, year, rename)
      .then((nm) => {
        if (!cancel) setNewNamePreview(nm);
      })
      .catch(() => {
        if (!cancel) setNewNamePreview(null);
      });
    return () => {
      cancel = true;
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

  const coverSrc =
    !proposed.coverUrl || coverFailed
      ? PLACEHOLDER_COVER
      : proposed.coverUrl;

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
        Drag the cover area right to accept, left to skip — or use the buttons
        below.
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
          <div className="compare-head">
            <span>Field</span>
            <span>Current</span>
            <span>Proposed</span>
          </div>
          <Field
            label="Artist"
            current={fmtCurrent(cur, "artist")}
            proposed={proposed.artist}
            onChange={(artist) => onProposedChange({ ...proposed, artist })}
            name="artist"
          />
          <Field
            label="Title"
            current={fmtCurrent(cur, "title")}
            proposed={proposed.title}
            onChange={(title) => onProposedChange({ ...proposed, title })}
            name="title"
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
