import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  applyBatch,
  batchLookup,
  clearSessionSnapshot,
  proposedFromTrack,
  scanFolder,
} from "./api/tauri";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { CleanFilenamesPage } from "./components/CleanFilenamesPage";
import { Logo } from "./components/Logo";
import { OptionsMenu } from "./components/OptionsMenu";
import { ApplyDonePanel } from "./components/ApplyDonePanel";
import { RekordboxXmlPage } from "./components/RekordboxXmlPage";
import { ReviewDeck } from "./components/ReviewDeck";
import { ReviewToolbar } from "./components/ReviewToolbar";
import { useAutotagSession } from "./hooks/useAutotagSession";
import { useLookupActions } from "./hooks/useLookupActions";
import { useLookupEvents } from "./hooks/useLookupEvents";
import { useProgressEvents } from "./hooks/useProgressEvents";
import { loadSettings, saveSettings } from "./options/storage";
import type { AppSettings, RenameSettings } from "./options/types";
import type {
  ApplyOutcome,
  ApplyPayload,
  ProposedTags,
  ReviewTrack,
  ScannedTrack,
  SkippedFile,
} from "./types";
import { parseU32 } from "./utils/parse";
import {
  bindAppScrollContainer,
  readDocumentScrollY,
  scheduleScrollAndReviewFocusRestore,
} from "./utils/scrollRestore";
import "./App.css";

type Phase = "import" | "review" | "apply_done";
type PageView = "home" | "autotag" | "clean_names" | "rekordbox_xml";

type LookupProgressState = {
  active: boolean;
  done: number;
  total: number;
};

type BackgroundCoverLookupState = {
  active: boolean;
  done: number;
  total: number;
  /** Lookup in progress for the track currently shown in review (spinner only). */
  workingOnCurrentFile: boolean;
};
function computeConfidenceScore(
  confidence: "high" | "medium" | "low",
  candidates: ReviewTrack["candidates"],
): number {
  if (candidates.length === 0) return 0;
  const top = candidates[0];
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
  return scanned.map((t) => {
    const lookup = lookupByPath.get(t.path);
    const candidates = lookup?.candidates ?? [];
    const confidence = lookup?.confidence ?? "low";
    return {
      ...t,
      candidates,
      candidateIndex: 0,
      reviewStatus: "pending" as const,
      confidence,
      confidenceScore: computeConfidenceScore(confidence, candidates),
      artistGuesses: lookup?.artistGuesses ?? [],
    };
  });
}

/** True if the current candidate already has usable cover art (no extra lookup needed). */
function currentTrackHasCoverArt(track: ReviewTrack): boolean {
  const c = track.candidates[track.candidateIndex];
  const p = proposedFromTrack(track);
  if (p.explicitlyNoCover) return false;
  if (p.coverUrl?.trim()) return true;
  if (c?.coverUrl?.trim()) return true;
  if ((c?.coverOptions?.length ?? 0) > 0) return true;
  if (track.current.hasEmbeddedCover) return true;
  return false;
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
    removeEmbeddedCover: p.explicitlyNoCover === true,
  };
}

/** Restore proposed tags from a stored apply payload (undo accept). */
function proposedFromApplyPayload(p: ApplyPayload): ProposedTags {
  return {
    artist: p.artist,
    title: p.title,
    album: p.album,
    albumArtist: p.albumArtist?.trim() ?? "",
    trackNumber: p.trackNumber != null ? String(p.trackNumber) : "",
    year: p.year != null ? String(p.year) : "",
    coverUrl: p.coverUrl,
    releaseMbid: p.releaseMbid?.trim() ? p.releaseMbid.trim() : null,
    explicitlyNoCover: p.removeEmbeddedCover === true,
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
          : "-";
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
  const [applyOutcomes, setApplyOutcomes] = useState<ApplyOutcome[] | null>(
    null,
  );
  const [acceptedPayloads, setAcceptedPayloads] = useState<ApplyPayload[]>([]);
  const [lookupProgress, setLookupProgress] = useState<LookupProgressState>({
    active: false,
    done: 0,
    total: 0,
  });
  const [lookupCurrentPath, setLookupCurrentPath] = useState<string | null>(null);
  const [skippedFiles, setSkippedFiles] = useState<SkippedFile[]>([]);
  const [autoAcceptedCount, setAutoAcceptedCount] = useState(0);
  const [keywordSearch, setKeywordSearch] = useState("");
  const [singleLookupPath, setSingleLookupPath] = useState<string | null>(null);
  const [backgroundCoverLookup, setBackgroundCoverLookup] =
    useState<BackgroundCoverLookupState>({
      active: false,
      done: 0,
      total: 0,
      workingOnCurrentFile: false,
    });
  const workingTrackKeyRef = useRef<string | null>(null);
  /** LIFO undo for Accept / Skip during review (path + kind). */
  const reviewNavStackRef = useRef<{ kind: "accept" | "skip"; path: string }[]>(
    [],
  );
  /** Bumps when the nav stack changes so the Back button disabled state updates. */
  const [reviewNavRev, setReviewNavRev] = useState(0);
  /** When set, the pending track with this path is shown first (after Back). */
  const [resumeReviewPath, setResumeReviewPath] = useState<string | null>(null);
  const resumeReviewPathRef = useRef<string | null>(null);
  const acceptedPayloadsRef = useRef(acceptedPayloads);
  const lookupRunIdRef = useRef(0);
  const reviewDeckAnchorRef = useRef<HTMLDivElement>(null);
  const coverAutoSearchAttemptedRef = useRef<Set<string>>(new Set());
  const coverAutoSearchDeclinedRef = useRef<Set<string>>(new Set());
  const backgroundCoverPassLockRef = useRef(false);
  const tracksRef = useRef(tracks);
  const lookupProgressActiveRef = useRef(lookupProgress.active);
  const singleLookupPathRef = useRef(singleLookupPath);
  const longTaskRef = useRef(longTask);
  const viewRef = useRef(view);
  const phaseRef = useRef(phase);
  const settingsMatchingRef = useRef(settings.matching);

  tracksRef.current = tracks;
  resumeReviewPathRef.current = resumeReviewPath;
  acceptedPayloadsRef.current = acceptedPayloads;
  lookupProgressActiveRef.current = lookupProgress.active;
  singleLookupPathRef.current = singleLookupPath;
  longTaskRef.current = longTask;
  viewRef.current = view;
  phaseRef.current = phase;
  settingsMatchingRef.current = settings.matching;

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
        const newConfidence = next.confidence ?? t.confidence;
        return {
          ...t,
          candidates: nextCandidates,
          candidateIndex: clampedIdx,
          confidence: newConfidence,
          confidenceScore: computeConfidenceScore(newConfidence, nextCandidates),
          artistGuesses: next.artistGuesses ?? t.artistGuesses,
        };
      }),
    );
  }, []);

  useLookupEvents(mergeLookupResults, lookupRunIdRef, settings.matching.verboseLogs);

  useEffect(() => {
    if (!progress || progress.kind !== "lookup") return;
    // Verbose debugging: see exactly which track lookup is currently running.
    if (settings.matching.verboseLogs) {
      console.debug("[lookup-progress]", {
        active: lookupProgress.active,
        done: progress.done,
        total: progress.total,
        message: progress.message ?? null,
      });
    }

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
  }, [lookupProgress.active, progress, settings.matching.verboseLogs]);

  const updateSettings = useCallback((next: AppSettings) => {
    setSettings(next);
    saveSettings(next);
  }, []);

  const current = useMemo(() => {
    const pending = tracks.filter((t) => t.reviewStatus === "pending");
    if (pending.length === 0) return undefined;
    if (resumeReviewPath) {
      const hit = pending.find((t) => t.path === resumeReviewPath);
      if (hit) return hit;
    }
    return pending[0];
  }, [tracks, resumeReviewPath]);

  useEffect(() => {
    if (!current) {
      workingTrackKeyRef.current = null;
      setWorking(null);
      return;
    }
    const key = `${current.path}:${current.candidateIndex}`;
    if (workingTrackKeyRef.current === key) {
      return;
    }
    workingTrackKeyRef.current = key;
    setWorking(proposedFromTrack(current));
  }, [current]);

  useEffect(() => {
    if (!settings.autoAcceptHighConfidence || phase !== "review") return;
    const threshold = Math.min(
      100,
      Math.max(0, settings.autoAcceptConfidenceThreshold),
    );
    const eligible = tracks.filter(
      (t) =>
        t.reviewStatus === "pending" &&
        t.confidenceScore >= threshold &&
        t.candidates.length > 0,
    );
    if (eligible.length === 0) return;
    const newPayloads: ApplyPayload[] = [];
    const acceptedPaths = new Set<string>();
    for (const t of eligible) {
      const p = proposedFromTrack(t);
      if (!p.artist.trim() || !p.title.trim()) continue;
      newPayloads.push(buildApplyPart(t.path, p));
      acceptedPaths.add(t.path);
      reviewNavStackRef.current.push({ kind: "accept", path: t.path });
    }
    if (acceptedPaths.size === 0) return;
    setReviewNavRev((v) => v + 1);
    setAcceptedPayloads((a) => [...a, ...newPayloads]);
    setAutoAcceptedCount((c) => c + acceptedPaths.size);
    setTracks((ts) =>
      ts.map((t) =>
        acceptedPaths.has(t.path) ? { ...t, reviewStatus: "accepted" } : t,
      ),
    );
  }, [
    tracks,
    settings.autoAcceptHighConfidence,
    settings.autoAcceptConfidenceThreshold,
    phase,
  ]);

  const pendingCount = useMemo(
    () => tracks.filter((t) => t.reviewStatus === "pending").length,
    [tracks],
  );

  const acceptedCount = useMemo(
    () => tracks.filter((t) => t.reviewStatus === "accepted").length,
    [tracks],
  );

  const pendingMissingCoverCount = useMemo(
    () =>
      tracks.filter(
        (t) => t.reviewStatus === "pending" && !currentTrackHasCoverArt(t),
      ).length,
    [tracks],
  );
  const currentCoverCount = useMemo(() => {
    if (!current) return 0;
    const c = current.candidates[current.candidateIndex];
    return c?.coverOptions?.length ?? 0;
  }, [current]);

  useEffect(() => {
    if (!current) return;
    if (settings.matching.verboseLogs) {
      console.debug("[covers-current]", {
        path: current.path,
        candidateIndex: current.candidateIndex,
        coverCount: currentCoverCount,
      });
    }
  }, [current?.path, current?.candidateIndex, currentCoverCount, settings.matching.verboseLogs]);
  const allDone = tracks.length > 0 && pendingCount === 0;
  const canReviewGoBack =
    phase === "review" &&
    reviewNavRev >= 0 &&
    reviewNavStackRef.current.length > 0;
  const hasActiveWork =
    tracks.length > 0 ||
    acceptedPayloads.length > 0 ||
    applyOutcomes !== null ||
    folder !== null ||
    phase !== "import";

  const { savedSession, setSavedSession, resumeChecked, applySnapshot } = useAutotagSession({
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
    setView,
    setPhase,
    setFolder,
    setSettings,
    setTracks,
    setWorking,
    setError,
    setApplyOutcomes,
    setAcceptedPayloads,
    setLookupProgress,
  });

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
      const result = await scanFolder(dir, settings.cleaning);
      const scanned = result.tracks;
      if (result.skipped.length > 0) {
        setSkippedFiles(result.skipped);
      }
      if (scanned.length === 0) {
        setError("No supported audio files found in this folder.");
        setLongTask(false);
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
      backgroundCoverPassLockRef.current = false;
      reviewNavStackRef.current = [];
      setReviewNavRev((v) => v + 1);
      setResumeReviewPath(null);
      coverAutoSearchAttemptedRef.current.clear();
      coverAutoSearchDeclinedRef.current.clear();
      setBackgroundCoverLookup({
        active: false,
        done: 0,
        total: 0,
        workingOnCurrentFile: false,
      });
      setTracks(review);
      setAcceptedPayloads([]);
      setAutoAcceptedCount(0);
      setApplyOutcomes(null);
      setPhase("review");
      setLongTask(false);

      if (items.length === 0 || !settings.autoLookupOnImport) {
        setLookupProgress({ active: false, done: 0, total: 0 });
        setLookupCurrentPath(null);
        return;
      }
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
          if (lookupRunIdRef.current === runId) {
            setLookupProgress((prev) => ({ ...prev, active: false, done: prev.total }));
            setLookupCurrentPath(null);
          }
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
    coverAutoSearchAttemptedRef.current.clear();
    reviewNavStackRef.current = [];
    setReviewNavRev((v) => v + 1);
    setResumeReviewPath(null);
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
        if (lookupRunIdRef.current === runId) {
          setLookupProgress((prev) => ({ ...prev, active: false, done: prev.total }));
          setLookupCurrentPath(null);
        }
      }
    })();
  };

  const {
    bumpCandidate,
    rerunSingleLookup,
    handleGuessArtist,
    handleMusicbrainzLookup,
  } = useLookupActions({
    matching: settings.matching,
    lookupRunIdRef,
    setTracks,
    setSingleLookupPath,
    setError,
    mergeLookupResults,
    current,
    working,
  });

  const handleSearchNewCovers = useCallback(() => {
    if (!current) return;
    coverAutoSearchDeclinedRef.current.delete(
      `${current.path}:${current.candidateIndex}`,
    );
    setWorking((w) => (w ? { ...w, explicitlyNoCover: false } : w));
    const artist = working?.artist?.trim() || current.cleaned.searchArtist;
    const title = working?.title?.trim() || current.cleaned.searchTitle;
    void rerunSingleLookup(current.path, artist, title, current.filenameStem);
  }, [
    current,
    working?.artist,
    working?.title,
    rerunSingleLookup,
  ]);

  const handleRunKeywordSearch = useCallback(() => {
    if (!current) return;
    const q = keywordSearch.trim();
    if (!q) {
      setError("Type keywords first (artist/title).");
      return;
    }
    setError(null);
    coverAutoSearchDeclinedRef.current.delete(
      `${current.path}:${current.candidateIndex}`,
    );
    setWorking((w) => (w ? { ...w, explicitlyNoCover: false } : w));
    void rerunSingleLookup(current.path, q, q, current.filenameStem);
  }, [current, keywordSearch, rerunSingleLookup]);

  const handleDeclineAutoCoverSearch = useCallback(
    (path: string, candidateIndex: number) => {
      coverAutoSearchDeclinedRef.current.add(`${path}:${candidateIndex}`);
    },
    [],
  );

  const runBackgroundCoverPass = useCallback(async () => {
    if (backgroundCoverPassLockRef.current) return;
    if (
      viewRef.current !== "autotag" ||
      phaseRef.current !== "review" ||
      longTaskRef.current ||
      lookupProgressActiveRef.current
    ) {
      return;
    }

    const pickNext = (): ReviewTrack | null => {
      for (const t of tracksRef.current) {
        if (t.reviewStatus !== "pending") continue;
        if (currentTrackHasCoverArt(t)) continue;
        const key = `${t.path}:${t.candidateIndex}`;
        if (coverAutoSearchDeclinedRef.current.has(key)) continue;
        if (coverAutoSearchAttemptedRef.current.has(key)) continue;
        return t;
      }
      return null;
    };

    if (!pickNext()) return;

    const runId = lookupRunIdRef.current;
    const estimateTotal = tracksRef.current.filter((t) => {
      if (t.reviewStatus !== "pending") return false;
      if (currentTrackHasCoverArt(t)) return false;
      const key = `${t.path}:${t.candidateIndex}`;
      if (coverAutoSearchDeclinedRef.current.has(key)) return false;
      if (coverAutoSearchAttemptedRef.current.has(key)) return false;
      return true;
    }).length;

    backgroundCoverPassLockRef.current = true;
    let done = 0;

    setBackgroundCoverLookup({
      active: true,
      done: 0,
      total: Math.max(estimateTotal, 1),
      workingOnCurrentFile: false,
    });

    try {
      while (true) {
        if (lookupRunIdRef.current !== runId) break;
        if (lookupProgressActiveRef.current) break;
        if (viewRef.current !== "autotag" || phaseRef.current !== "review") break;
        if (longTaskRef.current) break;

        while (singleLookupPathRef.current) {
          await new Promise((r) => setTimeout(r, 120));
          if (lookupRunIdRef.current !== runId) break;
        }
        if (lookupRunIdRef.current !== runId) break;

        const next = pickNext();
        if (!next) break;

        const key = `${next.path}:${next.candidateIndex}`;
        coverAutoSearchAttemptedRef.current.add(key);

        const p = proposedFromTrack(next);
        const artist = p.artist?.trim() || next.cleaned.searchArtist;
        const title = p.title?.trim() || next.cleaned.searchTitle;

        const pendingFront = tracksRef.current.find((t) => t.reviewStatus === "pending");
        const spinHere = Boolean(pendingFront && pendingFront.path === next.path);
        if (spinHere) {
          setBackgroundCoverLookup((prev) => ({
            ...prev,
            workingOnCurrentFile: true,
          }));
        }

        try {
          const one = await batchLookup(
            [
              {
                path: next.path,
                artist,
                title,
                filenameStem: next.filenameStem,
              },
            ],
            settingsMatchingRef.current,
            runId,
          );
          if (lookupRunIdRef.current === runId) {
            mergeLookupResults(one);
          }
        } catch (e) {
          setError(String(e));
        }

        done += 1;
        setBackgroundCoverLookup((prev) => ({
          ...prev,
          active: true,
          done,
          workingOnCurrentFile: false,
        }));
      }
    } finally {
      backgroundCoverPassLockRef.current = false;
      setBackgroundCoverLookup({
        active: false,
        done: 0,
        total: 0,
        workingOnCurrentFile: false,
      });
    }
  }, [mergeLookupResults]);

  useEffect(() => {
    if (view !== "autotag" || phase !== "review" || longTask) return;
    if (lookupProgress.active) return;
    if (pendingMissingCoverCount === 0) return;

    const id = window.setTimeout(() => {
      void runBackgroundCoverPass();
    }, 400);

    return () => window.clearTimeout(id);
  }, [
    view,
    phase,
    longTask,
    lookupProgress.active,
    pendingMissingCoverCount,
    singleLookupPath,
    runBackgroundCoverPass,
  ]);

  useEffect(() => {
    if (view !== "autotag" || phase !== "review") return;
    if (!current) return;
    if (longTask) return;
    if (lookupProgress.active) return;
    if (backgroundCoverPassLockRef.current) return;
    if (singleLookupPath) return;
    if (currentTrackHasCoverArt(current)) return;

    const key = `${current.path}:${current.candidateIndex}`;
    if (coverAutoSearchDeclinedRef.current.has(key)) return;
    if (coverAutoSearchAttemptedRef.current.has(key)) return;

    coverAutoSearchAttemptedRef.current.add(key);
    const p = proposedFromTrack(current);
    const artist = p.artist?.trim() || current.cleaned.searchArtist;
    const title = p.title?.trim() || current.cleaned.searchTitle;
    void rerunSingleLookup(current.path, artist, title, current.filenameStem);
  }, [
    view,
    phase,
    current,
    longTask,
    lookupProgress.active,
    singleLookupPath,
    rerunSingleLookup,
  ]);

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

  const handleGoBackReview = useCallback(() => {
    if (longTask) return;
    const stack = reviewNavStackRef.current;
    if (stack.length === 0) return;
    const last = stack.pop()!;
    setReviewNavRev((v) => v + 1);

    const scrollY = readDocumentScrollY();

    if (last.kind === "skip") {
      setTracks((ts) =>
        ts.map((t) =>
          t.path === last.path ? { ...t, reviewStatus: "pending" as const } : t,
        ),
      );
      setResumeReviewPath(last.path);
      workingTrackKeyRef.current = null;
      scheduleScrollAndReviewFocusRestore(scrollY, () =>
        reviewDeckAnchorRef.current,
      );
      return;
    }

    const trBefore = tracksRef.current.find((t) => t.path === last.path);
    const prev = acceptedPayloadsRef.current;
    let idx = -1;
    for (let i = prev.length - 1; i >= 0; i--) {
      if (prev[i].path === last.path) {
        idx = i;
        break;
      }
    }
    const removed = idx >= 0 ? prev[idx] : null;
    if (idx >= 0) {
      setAcceptedPayloads((p) => p.filter((_, i) => i !== idx));
    }

    if (removed && trBefore) {
      workingTrackKeyRef.current = `${last.path}:${trBefore.candidateIndex}`;
      setWorking(proposedFromApplyPayload(removed));
    } else {
      workingTrackKeyRef.current = null;
    }

    setTracks((ts) =>
      ts.map((t) =>
        t.path === last.path ? { ...t, reviewStatus: "pending" as const } : t,
      ),
    );
    setResumeReviewPath(last.path);
    scheduleScrollAndReviewFocusRestore(scrollY, () =>
      reviewDeckAnchorRef.current,
    );
  }, [longTask]);

  const handleAccept = useCallback(() => {
    if (!current || !working) return;
    if (!working.artist.trim() || !working.title.trim()) {
      setError(
        "Artist and title cannot be empty. Edit the proposed fields or skip.",
      );
      return;
    }
    reviewNavStackRef.current.push({ kind: "accept", path: current.path });
    setReviewNavRev((v) => v + 1);
    setResumeReviewPath(null);
    const scrollY = readDocumentScrollY();
    setError(null);
    const part = buildApplyPart(current.path, working);
    setAcceptedPayloads((a) => [...a, part]);
    setTracks((ts) =>
      ts.map((t) =>
        t.path === current.path ? { ...t, reviewStatus: "accepted" } : t,
      ),
    );
    scheduleScrollAndReviewFocusRestore(scrollY, () =>
      reviewDeckAnchorRef.current,
    );
  }, [current, working]);

  const handleSkip = useCallback(() => {
    const pending = tracksRef.current.filter(
      (t) => t.reviewStatus === "pending",
    );
    if (pending.length === 0) return;
    const rp = resumeReviewPathRef.current;
    const curTrack =
      rp != null
        ? pending.find((t) => t.path === rp) ?? pending[0]
        : pending[0];
    const curPath = curTrack.path;
    reviewNavStackRef.current.push({ kind: "skip", path: curPath });
    setReviewNavRev((v) => v + 1);
    setResumeReviewPath(null);
    const scrollY = readDocumentScrollY();
    setTracks((ts) => {
      const still = ts.find(
        (t) => t.path === curPath && t.reviewStatus === "pending",
      );
      if (!still) return ts;
      return ts.map((t) =>
        t.path === curPath ? { ...t, reviewStatus: "skipped" as const } : t,
      );
    });
    scheduleScrollAndReviewFocusRestore(scrollY, () =>
      reviewDeckAnchorRef.current,
    );
  }, []);

  const runApply = async (skipConfirm = false) => {
    if (acceptedPayloads.length === 0) return;
    const meta = {
      ...settings.applyMeta,
      genre: settings.applyMeta.genre?.trim() || null,
      grouping: settings.applyMeta.grouping?.trim() || null,
      comment: settings.applyMeta.comment?.trim() || null,
    };
    const metaForApply = { ...meta, writeTags: true };
    const renameForApply = { ...settings.rename, enabled: true };

    if (!skipConfirm) {
      const n = acceptedPayloads.length;
      const summary =
        `write embedded tags (and cover if enabled) and ` +
        `rename files on disk${renameConfirmHint(renameForApply)}`;
      const ok = window.confirm(
        `You are about to permanently change ${n} file${n === 1 ? "" : "s"}.\n\n` +
          `This will ${summary}.\n\n` +
          "There is no automatic undo. Continue?",
      );
      if (!ok) return;
    }

    clearProgress();
    setLongTask(true);
    setError(null);
    try {
      const outcomes = await applyBatch(
        acceptedPayloads,
        metaForApply,
        renameForApply,
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

  useEffect(() => {
    if (
      settings.autoApplyOnComplete &&
      allDone &&
      phase === "review" &&
      acceptedPayloads.length > 0 &&
      !longTask
    ) {
      void runApply(true);
    }
  }, [allDone, settings.autoApplyOnComplete, phase, acceptedPayloads.length, longTask]);

  const resetImport = () => {
    lookupRunIdRef.current += 1;
    backgroundCoverPassLockRef.current = false;
    reviewNavStackRef.current = [];
    setReviewNavRev((v) => v + 1);
    setResumeReviewPath(null);
    coverAutoSearchAttemptedRef.current.clear();
    coverAutoSearchDeclinedRef.current.clear();
    setBackgroundCoverLookup({
      active: false,
      done: 0,
      total: 0,
      workingOnCurrentFile: false,
    });
    workingTrackKeyRef.current = null;
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
    setSkippedFiles([]);
    setAutoAcceptedCount(0);
    void clearSessionSnapshot();
    setSavedSession(null);
  };

  const mainSurfaceKey =
    view === "autotag" ? (`autotag-${phase}` as const) : view;

  const coverProgressTotal = useMemo(() => tracks.length * 4, [tracks]);
  const coverProgressDone = useMemo(
    () =>
      tracks.reduce((acc, t) => {
        const best = t.candidates.reduce(
          (mx, c) => Math.max(mx, c.coverOptions?.length ?? 0),
          0,
        );
        return acc + Math.min(best, 4);
      }, 0),
    [tracks],
  );
  const currentReviewData = useMemo(() => {
    if (!current) return null;
    const currentCandidate = current.candidates[current.candidateIndex];
    const currentCoverCount = currentCandidate?.coverOptions?.length ?? 0;
    const coverSearchActive =
      lookupProgress.active ||
      singleLookupPath === current.path ||
      (backgroundCoverLookup.active &&
        backgroundCoverLookup.workingOnCurrentFile);
    return { currentCoverCount, coverSearchActive };
  }, [
    current,
    lookupProgress.active,
    singleLookupPath,
    backgroundCoverLookup.active,
    backgroundCoverLookup.workingOnCurrentFile,
  ]);

  // Move focus into the review region without scrolling; scroll position is
  useEffect(() => {
    if (view !== "autotag" || phase !== "review" || !current || allDone) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const ae = document.activeElement;
      if (
        ae instanceof HTMLInputElement ||
        ae instanceof HTMLTextAreaElement ||
        ae instanceof HTMLSelectElement
      ) {
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        handleAccept();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        handleSkip();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [view, phase, current, allDone, handleAccept, handleSkip]);

  // restored explicitly in handleAccept / handleSkip (Tauri WebView scrolls
  // to the first tabbable after the Accept button unmounts).
  useLayoutEffect(() => {
    if (view !== "autotag" || phase !== "review" || !current || allDone) return;
    const anchor = reviewDeckAnchorRef.current;
    if (!anchor) return;
    const ae = document.activeElement;
    if (
      ae instanceof HTMLElement &&
      (ae.isContentEditable ||
        ae instanceof HTMLButtonElement ||
        ae instanceof HTMLAnchorElement ||
        ae.closest("[data-no-review-refocus]"))
    ) {
      return;
    }
    if (
      ae instanceof HTMLInputElement ||
      ae instanceof HTMLTextAreaElement ||
      ae instanceof HTMLSelectElement
    ) {
      if (anchor.contains(ae)) return;
    }
    anchor.focus({ preventScroll: true });
  }, [current?.path, view, phase, allDone]);

  return (
    <div className="app-shell">
      <div className="app-bg" aria-hidden="true" />
      <div className="app">
        <LoadingOverlay open={longTask} progress={progress} />

        <header className="header">
          <div className="header-row">
            <div className="brand-row">
              <div className="brand-mark">
                <Logo className="brand-logo" />
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
            <div className="row">
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

        <div className="app-body" ref={(el) => bindAppScrollContainer(el)}>
        <OptionsMenu
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          settings={settings}
          onChange={updateSettings}
        />

        {skippedFiles.length > 0 && (
          <div className="modal-backdrop" onClick={() => setSkippedFiles([])}>
            <div
              className="modal-dialog skipped-files-dialog"
              onClick={(e) => e.stopPropagation()}
            >
              <h3>Unsupported files skipped</h3>
              <p className="muted">
                {skippedFiles.length} file{skippedFiles.length !== 1 ? "s were" : " was"} found
                but cannot be tagged. These formats don&apos;t support embedded metadata writing.
              </p>
              <div className="skipped-files-list">
                {skippedFiles.map((f) => (
                  <div key={f.path} className="skipped-file-item">
                    <span className="mono">{f.fileName}</span>
                    <span className="muted">{f.reason}</span>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="btn primary"
                onClick={() => setSkippedFiles([])}
              >
                OK
              </button>
            </div>
          </div>
        )}

        <div className="app-main-surface" key={mainSurfaceKey}>
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
            <div className="banner-slot-inline" aria-live="polite">
              {error && <div className="banner error">{error}</div>}
            </div>
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
          <div className="autotag-review-workspace">
            <ReviewToolbar
              totalFiles={tracks.length}
              acceptedCount={acceptedCount}
              pendingCount={pendingCount}
              autoAcceptedCount={autoAcceptedCount}
              lookupProgress={lookupProgress}
              backgroundCoverLookup={backgroundCoverLookup}
              coverProgressTotal={coverProgressTotal}
              coverProgressDone={coverProgressDone}
              longTask={longTask}
              canReviewGoBack={canReviewGoBack}
              onGoBackReview={handleGoBackReview}
              onRunLookup={runLookup}
              keywordSearch={keywordSearch}
              setKeywordSearch={setKeywordSearch}
              onRunKeywordSearch={handleRunKeywordSearch}
              keywordSearchDisabled={
                longTask ||
                !current ||
                keywordSearch.trim().length === 0 ||
                singleLookupPath === current.path
              }
              setSettingsOpen={setSettingsOpen}
              lookupCurrentPath={lookupCurrentPath}
            />

            <div className="banner-slot" aria-live="polite">
              {error && <div className="banner error">{error}</div>}
            </div>

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
                    onClick={() => runApply()}
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

            {current && working && !allDone && currentReviewData && (
              <div
                ref={reviewDeckAnchorRef}
                tabIndex={-1}
                className="review-deck-anchor"
                aria-label="Current track review"
              >
                <ReviewDeck
                  track={current}
                  proposed={working}
                  coverSearchActive={currentReviewData.coverSearchActive}
                  coverSearchCount={currentReviewData.currentCoverCount}
                  coverSearchTotal={4}
                  onProposedChange={setWorking}
                  onPrevCandidate={() => bumpCandidate(-1)}
                  onNextCandidate={() => bumpCandidate(1)}
                  onAccept={handleAccept}
                  onSkip={handleSkip}
                  onGuessArtist={handleGuessArtist}
                  onSwapArtistTitle={handleSwapArtistTitle}
                  onMusicbrainzLookup={handleMusicbrainzLookup}
                  onSearchNewCovers={handleSearchNewCovers}
                  onDeclineAutoCoverSearch={handleDeclineAutoCoverSearch}
                  rename={settings.rename}
                />
              </div>
            )}
          </div>
        )}

        {view === "autotag" && phase === "apply_done" && applyOutcomes && (
          <ApplyDonePanel
            applyOutcomes={applyOutcomes}
            onResetImport={resetImport}
            setView={setView}
          />
        )}
        </div>
        </div>
      </div>
    </div>
  );
}
