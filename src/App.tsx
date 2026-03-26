import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  applyBatch,
  batchLookup,
  clearSessionSnapshot,
  loadSessionSnapshot,
  musicbrainzLookupOne,
  proposedFromTrack,
  saveSessionSnapshot,
  scanFolder,
} from "./api/tauri";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { CleanFilenamesPage } from "./components/CleanFilenamesPage";
import { Logo } from "./components/Logo";
import { OptionsMenu } from "./components/OptionsMenu";
import { RekordboxXmlPage } from "./components/RekordboxXmlPage";
import { ReviewDeck } from "./components/ReviewDeck";
import { useProgressEvents } from "./hooks/useProgressEvents";
import { loadSettings, saveSettings } from "./options/storage";
import type { AppSettings, RenameSettings } from "./options/types";
import type {
  ApplyPayload,
  ProposedTags,
  ReviewTrack,
  ScannedTrack,
  LookupResult,
} from "./types";
import { parseU32 } from "./utils/parse";
import "./App.css";

type Phase = "import" | "review" | "apply_done";
type PageView = "home" | "autotag" | "clean_names" | "rekordbox_xml";

type LookupResultEventPayload = {
  run_id: number;
  result: LookupResult;
};
type LookupProgressState = {
  active: boolean;
  done: number;
  total: number;
};
type SessionSnapshot = {
  view: PageView;
  phase: Phase;
  folder: string | null;
  settings: AppSettings;
  tracks: ReviewTrack[];
  working: ProposedTags | null;
  error: string | null;
  applyOutcomes: { path: string; ok: boolean; error: string | null }[] | null;
  acceptedPayloads: ApplyPayload[];
  lookupProgress: LookupProgressState;
};

function toReviewTracks(
  scanned: ScannedTrack[],
  lookupByPath: Map<
    string,
    {
      candidates: ReviewTrack["candidates"];
      confidence?: ReviewTrack["confidence"];
      artistGuesses?: string[];
    }
  >,
): ReviewTrack[] {
  return scanned.map((t) => ({
    ...t,
    candidates: lookupByPath.get(t.path)?.candidates ?? [],
    candidateIndex: 0,
    reviewStatus: "pending" as const,
    confidence: lookupByPath.get(t.path)?.confidence ?? "low",
    artistGuesses: lookupByPath.get(t.path)?.artistGuesses ?? [],
  }));
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
  const [view, setView] = useState<PageView>("home");
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
  const [lookupProgress, setLookupProgress] = useState<LookupProgressState>({
    active: false,
    done: 0,
    total: 0,
  });
  const [lookupCurrentPath, setLookupCurrentPath] = useState<string | null>(null);
  const [singleLookupPath, setSingleLookupPath] = useState<string | null>(null);
  const [savedSession, setSavedSession] = useState<SessionSnapshot | null>(null);
  const [resumeChecked, setResumeChecked] = useState(false);
  const lookupRunIdRef = useRef(0);
  const autosaveTimerRef = useRef<number | null>(null);

  const { progress, clearProgress } = useProgressEvents(true);

  const mergeLookupResults = useCallback((results: {
    path: string;
    candidates: ReviewTrack["candidates"];
    confidence?: ReviewTrack["confidence"];
    artistGuesses?: string[];
  }[]) => {
    if (results.length === 0) return;
    const m = new Map(
      results.map((r) => [r.path, { candidates: r.candidates, confidence: r.confidence, artistGuesses: r.artistGuesses }] as const),
    );
    setTracks((prev) =>
      prev.map((t) => {
        const next = m.get(t.path);
        if (!next) return t;
        const nextCandidates = next.candidates;
        const clampedIdx =
          t.candidateIndex >= nextCandidates.length ? 0 : t.candidateIndex;
        return {
          ...t,
          candidates: nextCandidates,
          candidateIndex: clampedIdx,
          confidence: next.confidence ?? t.confidence,
          artistGuesses: next.artistGuesses ?? t.artistGuesses,
        };
      }),
    );
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void (async () => {
      unlisten = await listen<LookupResultEventPayload>(
        "lookup_result",
        (e) => {
          const payload = e.payload;
          if (payload.run_id !== lookupRunIdRef.current) return;
          const firstCoverOpts =
            payload.result.candidates[0]?.coverOptions?.length ?? 0;
          console.debug("[lookup_result]", {
            path: payload.result.path,
            candidates: payload.result.candidates.length,
            firstCoverOpts,
          });
          mergeLookupResults([payload.result]);
        },
      );
    })();
    return () => {
      unlisten?.();
    };
  }, [mergeLookupResults]);

  useEffect(() => {
    if (!progress || progress.kind !== "lookup") return;
    // Verbose debugging: see exactly which track lookup is currently running.
    console.debug("[lookup-progress]", {
      active: lookupProgress.active,
      done: progress.done,
      total: progress.total,
      message: progress.message ?? null,
    });

    if (!lookupProgress.active) return;
    if (progress.message) {
      setLookupCurrentPath(progress.message);
    }
    setLookupProgress((prev) => {
      if (!prev.active) return prev;
      const total = progress.total > 0 ? progress.total : prev.total;
      const done = Math.min(progress.done, total || progress.done);
      return { ...prev, done, total };
    });
  }, [lookupProgress.active, progress]);

  useEffect(() => {
    let cancelled = false;
    void loadSessionSnapshot()
      .then((raw) => {
        if (cancelled) return;
        const snap = raw as SessionSnapshot | null;
        setSavedSession(snap && snap.tracks ? snap : null);
      })
      .finally(() => {
        if (!cancelled) setResumeChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
  const currentCoverCount = useMemo(() => {
    if (!current) return 0;
    const c = current.candidates[current.candidateIndex];
    return c?.coverOptions?.length ?? 0;
  }, [current]);

  useEffect(() => {
    if (!current) return;
    console.debug("[covers-current]", {
      path: current.path,
      candidateIndex: current.candidateIndex,
      coverCount: currentCoverCount,
    });
  }, [current?.path, current?.candidateIndex, currentCoverCount]);
  const allDone = tracks.length > 0 && pendingCount === 0;
  const hasActiveWork =
    tracks.length > 0 ||
    acceptedPayloads.length > 0 ||
    applyOutcomes !== null ||
    folder !== null ||
    phase !== "import";

  const applySnapshot = useCallback((snap: SessionSnapshot) => {
    setView(snap.view);
    setPhase(snap.phase);
    setFolder(snap.folder);
    setSettings(snap.settings);
    saveSettings(snap.settings);
    setTracks(snap.tracks);
    setWorking(snap.working);
    setError(snap.error);
    setApplyOutcomes(snap.applyOutcomes);
    setAcceptedPayloads(snap.acceptedPayloads);
    setLookupProgress(snap.lookupProgress);
  }, []);

  const goHome = useCallback(() => {
    if (view === "home") return;
    if (hasActiveWork) {
      const ok = window.confirm(
        "Go to Home now? Your progress is autosaved and can be resumed later.",
      );
      if (!ok) return;
    }
    setView("home");
  }, [hasActiveWork, view]);

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
      const review = toReviewTracks(scanned, new Map());
      const items = scanned.map((t) => ({
        path: t.path,
        artist: t.cleaned.searchArtist,
        title: t.cleaned.searchTitle,
        filenameStem: t.filenameStem,
      }));
      const runId = items.length > 0 ? ++lookupRunIdRef.current : lookupRunIdRef.current;
      setTracks(review);
      setAcceptedPayloads([]);
      setApplyOutcomes(null);
      setPhase("review");
      setLongTask(false);

      if (items.length === 0) return;
      setLookupProgress({ active: true, done: 0, total: items.length });
      setLookupCurrentPath(null);
      void (async () => {
        try {
          const all = await batchLookup(items, settings.matching, runId);
          if (lookupRunIdRef.current !== runId) return;
          mergeLookupResults(all);
        } catch (e) {
          if (lookupRunIdRef.current !== runId) return;
          setError(String(e));
        } finally {
          if (lookupRunIdRef.current !== runId) return;
          setLookupProgress((prev) => ({ ...prev, active: false, done: prev.total }));
          setLookupCurrentPath(null);
        }
      })();
    } catch (e) {
      setError(String(e));
      setLongTask(false);
    }
  };

  const startAutotagImport = async () => {
    await clearSessionSnapshot();
    setSavedSession(null);
    setView("autotag");
    setPhase("import");
    await pickFolder();
  };

  const runLookup = async () => {
    if (!folder || tracks.length === 0 || longTask) return;
    setError(null);
    clearProgress();
    const items = tracks.map((t) => ({
      path: t.path,
      artist: t.cleaned.searchArtist,
      title: t.cleaned.searchTitle,
      filenameStem: t.filenameStem,
    }));
    if (items.length === 0) return;
    const runId = ++lookupRunIdRef.current;
    setLookupProgress({ active: true, done: 0, total: items.length });
    setLookupCurrentPath(null);
    try {
      const first = await batchLookup([items[0]], settings.matching, runId);
      if (lookupRunIdRef.current !== runId) return;
      mergeLookupResults(first);
    } catch (e) {
      if (lookupRunIdRef.current !== runId) return;
      setError(String(e));
    }
    if (items.length === 1) {
      if (lookupRunIdRef.current === runId) {
        setLookupProgress((prev) => ({ ...prev, active: false, done: prev.total || 1 }));
        setLookupCurrentPath(null);
      }
      return;
    }
    void (async () => {
      try {
        const rest = await batchLookup(items.slice(1), settings.matching, runId);
        if (lookupRunIdRef.current !== runId) return;
        mergeLookupResults(rest);
      } catch (e) {
        if (lookupRunIdRef.current !== runId) return;
        setError(String(e));
      } finally {
        if (lookupRunIdRef.current !== runId) return;
        setLookupProgress((prev) => ({ ...prev, active: false, done: prev.total }));
        setLookupCurrentPath(null);
      }
    })();
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

  const rerunSingleLookup = useCallback(
    async (path: string, artist: string, title: string, filenameStem: string) => {
      setSingleLookupPath(path);
      try {
        const one = await batchLookup(
          [{ path, artist, title, filenameStem }],
          settings.matching,
          lookupRunIdRef.current,
        );
        mergeLookupResults(one);
      } catch (e) {
        setError(String(e));
      } finally {
        setSingleLookupPath((prev) => (prev === path ? null : prev));
      }
    },
    [mergeLookupResults, settings.matching],
  );

  const rerunSingleMusicbrainz = useCallback(
    async (path: string, artist: string, title: string, filenameStem: string) => {
      setSingleLookupPath(path);
      try {
        const one = await musicbrainzLookupOne(
          { path, artist, title, filenameStem },
          settings.matching,
        );
        mergeLookupResults([one]);
      } catch (e) {
        setError(String(e));
      } finally {
        setSingleLookupPath((prev) => (prev === path ? null : prev));
      }
    },
    [mergeLookupResults, settings.matching],
  );

  const handleGuessArtist = useCallback(
    (artistGuess: string) => {
      if (!current) return;
      const title = working?.title?.trim() || current.cleaned.searchTitle;
      void rerunSingleLookup(current.path, artistGuess, title, current.filenameStem);
    },
    [current, rerunSingleLookup, working?.title],
  );

  const handleSwapArtistTitle = useCallback(() => {
    setWorking((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        artist: prev.title,
        title: prev.artist,
      };
    });
  }, []);

  const handleMusicbrainzLookup = useCallback(() => {
    if (!current) return;
    const artist = working?.artist?.trim() || current.cleaned.searchArtist;
    const title = working?.title?.trim() || current.cleaned.searchTitle;
    void rerunSingleMusicbrainz(current.path, artist, title, current.filenameStem);
  }, [current, rerunSingleMusicbrainz, working?.artist, working?.title]);

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
      await clearSessionSnapshot();
      setSavedSession(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLongTask(false);
    }
  };

  const resetImport = () => {
    lookupRunIdRef.current += 1;
    setLookupProgress({ active: false, done: 0, total: 0 });
    setLookupCurrentPath(null);
    clearProgress();
    setPhase("import");
    setTracks([]);
    setFolder(null);
    setWorking(null);
    setAcceptedPayloads([]);
    setApplyOutcomes(null);
    setError(null);
    void clearSessionSnapshot();
    setSavedSession(null);
  };

  useEffect(() => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = window.setTimeout(() => {
      const snapshot: SessionSnapshot = {
        view,
        phase,
        folder,
        settings,
        tracks,
        working,
        error,
        applyOutcomes,
        acceptedPayloads,
        lookupProgress,
      };
      void saveSessionSnapshot(snapshot).then(() => setSavedSession(snapshot));
    }, 500);
    return () => {
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current);
      }
    };
  }, [
    acceptedPayloads,
    applyOutcomes,
    error,
    folder,
    lookupProgress,
    phase,
    settings,
    tracks,
    view,
    working,
  ]);

  return (
    <div className="app-shell">
      <div className="app-bg" aria-hidden="true" />
      <div className="app">
        <LoadingOverlay open={longTask} progress={progress} />

        <header className="header">
          <div className="header-row">
            <div className="brand-row">
              <div className="brand-mark">
                <Logo className="brand-logo" size={48} />
              </div>
              <div className="brand-block">
                <span className="brand-badge">Music library</span>
                <h1>Library Autotag</h1>
                <p className="tagline">
                  EDM / techno / hardcore: clean names, MusicBrainz match, verify,
                  then tag and rename.
                </p>
              </div>
            </div>
            <div className="row" style={{ gap: "0.5rem" }}>
              {view !== "home" && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  aria-label="Go home"
                  onClick={goHome}
                >
                  Home
                </button>
              )}
              <button
                type="button"
                className="btn btn-ghost settings-btn"
                aria-label="Open settings"
                onClick={() => setSettingsOpen(true)}
              >
                <svg
                  className="settings-icon"
                  viewBox="0 0 18 24"
                  width={18}
                  height={24}
                  aria-hidden="true"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <g
                    transform="translate(9 12) scale(0.52) translate(-12 -12)"
                    fill="currentColor"
                  >
                    <path d="M12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zm7.43-2.53c.04-.32.07-.64.07-.97s-.03-.66-.07-.98l2.11-1.63c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.37-.31-.59-.22l-2.49 1c-.52-.4-1.06-.73-1.69-.98l-.37-2.65A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.5.42l-.37 2.65c-.63.25-1.17.59-1.69.98l-2.49-1c-.22-.09-.47 0-.59.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.63c-.04.32-.07.65-.07.98s.03.65.07.97l-2.11 1.63c-.19.15-.24.42-.12.64l2 3.46c.12.22.37.3.59.22l2.49-1.01c.52.39 1.06.73 1.69.98l.37 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.37-2.65c.63-.26 1.17-.59 1.69-.98l2.49 1.01c.22.08.47 0 .59-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.63z" />
                  </g>
                </svg>
                Settings
              </button>
            </div>
          </div>
        </header>

        <OptionsMenu
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          settings={settings}
          onChange={updateSettings}
        />

        {view === "home" && (
          <section className="panel panel-hero">
            <p className="muted import-hint">
              Pick a workflow. You can still tune everything from <strong>Settings</strong>.
            </p>
            <div className="quick-actions-grid">
              {resumeChecked && savedSession && (
                <button
                  type="button"
                  className="quick-action-card"
                  onClick={() => applySnapshot(savedSession)}
                  disabled={longTask}
                >
                  <span className="quick-action-title">Resume last session</span>
                  <span className="quick-action-sub">Continue review/apply where you stopped.</span>
                </button>
              )}
              <button
                type="button"
                className="quick-action-card"
                onClick={startAutotagImport}
                disabled={longTask}
              >
                <span className="quick-action-title">Choose music folder</span>
                <span className="quick-action-sub">Run full autotag review + apply flow.</span>
              </button>
              <button
                type="button"
                className="quick-action-card"
                onClick={() => setView("clean_names")}
                disabled={longTask}
              >
                <span className="quick-action-title">Clean file names</span>
                <span className="quick-action-sub">Preview cleaned names and rename selected files.</span>
              </button>
              <button
                type="button"
                className="quick-action-card"
                onClick={() => setView("rekordbox_xml")}
                disabled={longTask}
              >
                <span className="quick-action-title">Rekordbox XML import/export</span>
                <span className="quick-action-sub">Import XML, match tracks, apply Rekordbox fields.</span>
              </button>
              {folder && (
                <button
                  type="button"
                  className="quick-action-card"
                  onClick={async () => {
                    setView("autotag");
                    setPhase("import");
                    await pickFolder();
                  }}
                  disabled={longTask}
                >
                  <span className="quick-action-title">Choose another music folder</span>
                  <span className="quick-action-sub">Start a new autotag import session.</span>
                </button>
              )}
              <button
                type="button"
                className="quick-action-card"
                onClick={() => setSettingsOpen(true)}
                disabled={longTask}
              >
                <span className="quick-action-title">Open settings</span>
                <span className="quick-action-sub">Tune cleaning, matching, apply, and rename behavior.</span>
              </button>
            </div>
            {folder && <p className="muted">Last folder: {folder}</p>}
          </section>
        )}

        {view === "clean_names" && (
          <CleanFilenamesPage
            cleaning={settings.cleaning}
            onBack={() => setView("home")}
          />
        )}

        {view === "rekordbox_xml" && (
          <RekordboxXmlPage
            cleaning={settings.cleaning}
            onBack={() => setView("home")}
          />
        )}

        {view === "autotag" && phase === "import" && (
          <section className="panel panel-hero">
            <p className="muted import-hint">
              Configure cleaning, matching, and metadata in{" "}
              <strong>Settings</strong>, then choose a folder.
            </p>
            <div className="row" style={{ marginBottom: "0.75rem" }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setView("home")}
                disabled={longTask}
              >
                Back to home
              </button>
            </div>
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

        {view === "autotag" && phase === "review" && (
          <>
            {(() => {
              const coverProgressTotal = tracks.length * 4;
              const coverProgressDone = tracks.reduce((acc, t) => {
                const best = t.candidates.reduce(
                  (mx, c) => Math.max(mx, c.coverOptions?.length ?? 0),
                  0,
                );
                return acc + Math.min(best, 4);
              }, 0);
              return (
            <section className="toolbar">
              <div className="toolbar-inner">
                <span className="stat stat-pill">
                  <strong>{tracks.length}</strong> files
                  <span className="stat-divider" aria-hidden="true" />
                  <strong>{pendingCount}</strong> left
                </span>
                {lookupProgress.active && lookupProgress.total > 0 && (
                  <div className="lookup-progress" aria-live="polite">
                    <span className="lookup-progress-label">Lookup progress</span>
                    <progress
                      className="lookup-progress-bar"
                      max={lookupProgress.total}
                      value={Math.min(lookupProgress.done, lookupProgress.total)}
                    />
                    <span className="lookup-progress-text">
                      {Math.min(lookupProgress.done, lookupProgress.total)} /{" "}
                      {lookupProgress.total}
                    </span>
                  </div>
                )}
                {coverProgressTotal > 0 && (
                  <div className="lookup-progress" aria-live="polite">
                    <span className="lookup-progress-label">Covers loaded</span>
                    <progress
                      className="lookup-progress-bar"
                      max={coverProgressTotal}
                      value={Math.min(coverProgressDone, coverProgressTotal)}
                    />
                    <span className="lookup-progress-text">
                      {Math.min(coverProgressDone, coverProgressTotal)} /{" "}
                      {coverProgressTotal}
                    </span>
                  </div>
                )}
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
              {lookupProgress.active && lookupCurrentPath && (
                <div className="muted" style={{ marginTop: "0.45rem", fontSize: "0.78rem" }}>
                  Current lookup: {lookupCurrentPath}
                </div>
              )}
            </section>
              );
            })()}

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
              (() => {
                const currentCandidate = current.candidates[current.candidateIndex];
                const currentCoverCount = currentCandidate?.coverOptions?.length ?? 0;
                const coverSearchActive =
                  lookupProgress.active ||
                  singleLookupPath === current.path;
                return (
              <ReviewDeck
                track={current}
                proposed={working}
                coverSearchActive={coverSearchActive}
                coverSearchCount={currentCoverCount}
                coverSearchTotal={4}
                onProposedChange={setWorking}
                onPrevCandidate={() => bumpCandidate(-1)}
                onNextCandidate={() => bumpCandidate(1)}
                onAccept={handleAccept}
                onSkip={handleSkip}
                onGuessArtist={handleGuessArtist}
                onSwapArtistTitle={handleSwapArtistTitle}
                onMusicbrainzLookup={handleMusicbrainzLookup}
                rename={settings.rename}
              />
                );
              })()
            )}
          </>
        )}

        {view === "autotag" && phase === "apply_done" && applyOutcomes && (
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
            <button
              type="button"
              className="btn"
              onClick={() => setView("home")}
              style={{ marginLeft: "0.5rem" }}
            >
              Back to home
            </button>
          </section>
        )}
      </div>
    </div>
  );
}
