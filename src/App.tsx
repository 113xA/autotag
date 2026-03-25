import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  applyBatch,
  batchLookup,
  proposedFromTrack,
  scanFolder,
} from "./api/tauri";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { OptionsMenu } from "./components/OptionsMenu";
import { ReviewDeck } from "./components/ReviewDeck";
import { useProgressEvents } from "./hooks/useProgressEvents";
import { loadSettings, saveSettings } from "./options/storage";
import type { AppSettings, RenameSettings } from "./options/types";
import type { ApplyPayload, ProposedTags, ReviewTrack, ScannedTrack } from "./types";
import "./App.css";

type Phase = "import" | "review" | "apply_done";

function toReviewTracks(
  scanned: ScannedTrack[],
  lookupByPath: Map<string, ReviewTrack["candidates"]>,
): ReviewTrack[] {
  return scanned.map((t) => ({
    ...t,
    candidates: lookupByPath.get(t.path) ?? [],
    candidateIndex: 0,
    reviewStatus: "pending" as const,
  }));
}

/** Strict non-negative integer for track # / year (avoids parseInt partial matches). */
function parseU32(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  if (!/^\d{1,9}$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function buildApplyPart(path: string, p: ProposedTags): ApplyPayload {
  const tn = p.trackNumber.trim();
  const yr = p.year.trim();
  const rm = p.releaseMbid?.trim();
  return {
    path,
    artist: p.artist.trim(),
    title: p.title.trim(),
    album: p.album.trim(),
    albumArtist: p.albumArtist.trim() || null,
    trackNumber: tn ? parseU32(tn) : null,
    year: yr ? parseU32(yr) : null,
    coverUrl: p.coverUrl,
    releaseMbid: rm || null,
  };
}

/** Short description of the rename pattern for the apply confirmation dialog. */
function renameConfirmHint(rename: RenameSettings): string {
  if (!rename.enabled) return "";
  const bits: string[] = [];
  if (rename.includeArtist) bits.push("artist");
  if (rename.includeTitle) bits.push("title");
  if (rename.includeAlbum) bits.push("album");
  if (rename.includeYear) bits.push("year");
  const sep =
    rename.separator === "underscore"
      ? "_"
      : rename.separator === "dot"
        ? "·"
        : rename.separator === "dashTight"
          ? "-"
          : "–";
  const order =
    rename.partOrder === "titleFirst" ? "title first" : "artist first";
  return ` (${bits.join(` ${sep} `)}; ${order})`;
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("import");
  const [folder, setFolder] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tracks, setTracks] = useState<ReviewTrack[]>([]);
  const [working, setWorking] = useState<ProposedTags | null>(null);
  const [longTask, setLongTask] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyOutcomes, setApplyOutcomes] = useState<
    { path: string; ok: boolean; error: string | null }[] | null
  >(null);
  const [acceptedPayloads, setAcceptedPayloads] = useState<ApplyPayload[]>([]);

  const { progress, clearProgress } = useProgressEvents(true);

  const updateSettings = useCallback((next: AppSettings) => {
    setSettings(next);
    saveSettings(next);
  }, []);

  const current = useMemo(
    () => tracks.find((t) => t.reviewStatus === "pending"),
    [tracks],
  );

  useEffect(() => {
    if (!current) {
      setWorking(null);
      return;
    }
    setWorking(proposedFromTrack(current));
  }, [current]);

  const pendingCount = useMemo(
    () => tracks.filter((t) => t.reviewStatus === "pending").length,
    [tracks],
  );
  const allDone = tracks.length > 0 && pendingCount === 0;

  const pickFolder = async () => {
    if (longTask) return;
    setError(null);
    const dir = await open({ directory: true, multiple: false });
    if (dir === null || Array.isArray(dir)) return;
    setFolder(dir);
    clearProgress();
    setLongTask(true);
    try {
      const scanned = await scanFolder(dir, settings.cleaning);
      if (scanned.length === 0) {
        setError("No supported audio files found (mp3, flac, m4a, ogg, opus).");
        return;
      }
      let review = toReviewTracks(scanned, new Map());
      if (settings.autoLookupOnImport) {
        const items = scanned.map((t) => ({
          path: t.path,
          artist: t.cleaned.searchArtist,
          title: t.cleaned.searchTitle,
        }));
        const results = await batchLookup(items, settings.matching);
        const m = new Map(
          results.map((r) => [r.path, r.candidates] as const),
        );
        review = toReviewTracks(scanned, m);
      }
      setTracks(review);
      setAcceptedPayloads([]);
      setApplyOutcomes(null);
      setPhase("review");
    } catch (e) {
      setError(String(e));
    } finally {
      setLongTask(false);
    }
  };

  const runLookup = async () => {
    if (!folder || tracks.length === 0 || longTask) return;
    setError(null);
    clearProgress();
    setLongTask(true);
    try {
      const items = tracks.map((t) => ({
        path: t.path,
        artist: t.cleaned.searchArtist,
        title: t.cleaned.searchTitle,
      }));
      const results = await batchLookup(items, settings.matching);
      const m = new Map(results.map((r) => [r.path, r.candidates] as const));
      setTracks((prev) =>
        prev.map((t) => {
          const nextCandidates = m.get(t.path) ?? t.candidates;
          const clampedIdx =
            t.candidateIndex >= nextCandidates.length ? 0 : t.candidateIndex;
          return {
            ...t,
            candidates: nextCandidates,
            candidateIndex: clampedIdx,
          };
        }),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setLongTask(false);
    }
  };

  const bumpCandidate = useCallback((delta: number) => {
    setTracks((ts) => {
      const curPath = ts.find((t) => t.reviewStatus === "pending")?.path;
      if (!curPath) return ts;
      return ts.map((t) => {
        if (t.path !== curPath) return t;
        const n = t.candidates.length;
        if (n === 0) return t;
        const next = (t.candidateIndex + delta + n) % n;
        return { ...t, candidateIndex: next };
      });
    });
  }, []);

  const handleAccept = useCallback(() => {
    if (!current || !working) return;
    if (!working.artist.trim() || !working.title.trim()) {
      setError(
        "Artist and title cannot be empty. Edit the proposed fields or skip.",
      );
      return;
    }
    setError(null);
    const part = buildApplyPart(current.path, working);
    setAcceptedPayloads((a) => [...a, part]);
    setTracks((ts) =>
      ts.map((t) =>
        t.path === current.path ? { ...t, reviewStatus: "accepted" } : t,
      ),
    );
  }, [current, working]);

  const handleSkip = useCallback(() => {
    setTracks((ts) => {
      const curPath = ts.find((t) => t.reviewStatus === "pending")?.path;
      if (!curPath) return ts;
      return ts.map((t) =>
        t.path === curPath ? { ...t, reviewStatus: "skipped" } : t,
      );
    });
  }, []);

  const runApply = async () => {
    if (acceptedPayloads.length === 0) return;
    const meta = {
      ...settings.applyMeta,
      genre: settings.applyMeta.genre?.trim() || null,
      grouping: settings.applyMeta.grouping?.trim() || null,
      comment: settings.applyMeta.comment?.trim() || null,
    };
    if (!meta.writeTags && !settings.rename.enabled) {
      setError("Enable “Write tags” and/or “Rename files on apply” in settings.");
      return;
    }
    const n = acceptedPayloads.length;
    const willTag = meta.writeTags;
    const willRename = settings.rename.enabled;
    const actions: string[] = [];
    if (willTag) actions.push("write embedded tags (and cover if enabled)");
    if (willRename) {
      actions.push(
        `rename files on disk${renameConfirmHint(settings.rename)}`,
      );
    }
    const summary = actions.join(" and ");
    const ok = window.confirm(
      `You are about to permanently change ${n} file${n === 1 ? "" : "s"}.\n\n` +
        `This will ${summary}.\n\n` +
        "There is no automatic undo. Continue?",
    );
    if (!ok) return;

    clearProgress();
    setLongTask(true);
    setError(null);
    try {
      const outcomes = await applyBatch(
        acceptedPayloads,
        meta,
        settings.rename,
      );
      setApplyOutcomes(outcomes);
      setPhase("apply_done");
    } catch (e) {
      setError(String(e));
    } finally {
      setLongTask(false);
    }
  };

  const resetImport = () => {
    setPhase("import");
    setTracks([]);
    setFolder(null);
    setWorking(null);
    setAcceptedPayloads([]);
    setApplyOutcomes(null);
    setError(null);
  };

  return (
    <div className="app-shell">
      <div className="app-bg" aria-hidden="true" />
      <div className="app">
      <LoadingOverlay open={longTask} progress={progress} />

      <header className="header">
        <div className="header-row">
          <div className="brand-block">
            <span className="brand-badge">Music library</span>
            <h1>Library Autotag</h1>
            <p className="tagline">
              EDM / techno / hardcore: clean names, MusicBrainz match, verify, then
              tag and rename.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost settings-btn"
            onClick={() => setSettingsOpen(true)}
          >
            <span className="btn-icon-label" aria-hidden="true">⚙</span>
            Settings
          </button>
        </div>
      </header>

      <OptionsMenu
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onChange={updateSettings}
      />

      {phase === "import" && (
        <section className="panel panel-hero">
          <p className="muted import-hint">
            Configure cleaning, matching, and metadata in{" "}
            <strong>Settings</strong>, then choose a folder.
          </p>
          <button
            type="button"
            className="btn primary"
            onClick={pickFolder}
            disabled={longTask}
          >
            Choose music folder
          </button>
          {folder && <p className="muted">Last folder: {folder}</p>}
        </section>
      )}

      {phase === "review" && (
        <>
          <section className="toolbar">
            <div className="toolbar-inner">
              <span className="stat stat-pill">
                <strong>{tracks.length}</strong> files
                <span className="stat-divider" aria-hidden="true" />
                <strong>{pendingCount}</strong> left
              </span>
              <div className="toolbar-actions">
                <button type="button" className="btn btn-secondary" onClick={runLookup} disabled={longTask}>
                  Re-run lookup
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setSettingsOpen(true)}
                >
                  Options
                </button>
              </div>
            </div>
          </section>

          {error && <div className="banner error">{error}</div>}

          <details className="file-details">
            <summary>All files ({tracks.length})</summary>
            <div className="file-table-wrap">
              <table className="file-table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Path</th>
                    <th>Cleaned</th>
                    <th>Tags</th>
                  </tr>
                </thead>
                <tbody>
                  {tracks.map((t) => (
                    <tr key={t.path}>
                      <td className="mono">{t.fileName}</td>
                      <td className="mono narrow-path">{t.path}</td>
                      <td>{t.cleaned.display}</td>
                      <td>
                        {t.current.artist ?? "—"} — {t.current.title ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          {allDone && (
            <section className="panel apply-panel panel-accent">
              <p className="apply-panel-lead">
                Review complete. <strong>{acceptedPayloads.length}</strong>{" "}
                accepted for apply.
              </p>
              <div className="row">
                <button
                  type="button"
                  className="btn primary"
                  onClick={runApply}
                  disabled={acceptedPayloads.length === 0 || longTask}
                >
                  Apply all accepted
                </button>
                <button type="button" className="btn" onClick={resetImport}>
                  Start over
                </button>
              </div>
            </section>
          )}

          {current && working && !allDone && (
            <ReviewDeck
              track={current}
              proposed={working}
              onProposedChange={setWorking}
              onPrevCandidate={() => bumpCandidate(-1)}
              onNextCandidate={() => bumpCandidate(1)}
              onAccept={handleAccept}
              onSkip={handleSkip}
              rename={settings.rename}
            />
          )}
        </>
      )}

      {phase === "apply_done" && applyOutcomes && (
        <section className="panel panel-done">
          <h2 className="panel-title">Apply finished</h2>
          <ul className="outcomes">
            {applyOutcomes.map((o) => (
              <li key={o.path} className={o.ok ? "ok" : "bad"}>
                <span className="path">{o.path}</span>
                {o.ok ? (
                  <span>OK</span>
                ) : (
                  <span className="err">{o.error}</span>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className="btn primary" onClick={resetImport}>
            New session
          </button>
        </section>
      )}
      </div>
    </div>
  );
}
