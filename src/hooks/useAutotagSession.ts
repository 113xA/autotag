import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { loadSessionSnapshot, saveSessionSnapshot } from "../api/tauri";
import { saveSettings } from "../options/storage";
import type { AppSettings } from "../options/types";
import type { ApplyOutcome, ApplyPayload, ProposedTags, ReviewTrack } from "../types";

type Phase = "import" | "review" | "apply_done";
type PageView = "home" | "autotag" | "clean_names" | "rekordbox_xml";
type LookupProgressState = {
  active: boolean;
  done: number;
  total: number;
};

export type SessionSnapshot = {
  view: PageView;
  phase: Phase;
  folder: string | null;
  settings: AppSettings;
  tracks: ReviewTrack[];
  working: ProposedTags | null;
  error: string | null;
  applyOutcomes: ApplyOutcome[] | null;
  acceptedPayloads: ApplyPayload[];
  lookupProgress: LookupProgressState;
};

type UseAutotagSessionArgs = {
  view: PageView;
  phase: Phase;
  folder: string | null;
  settings: AppSettings;
  tracks: ReviewTrack[];
  working: ProposedTags | null;
  error: string | null;
  applyOutcomes: ApplyOutcome[] | null;
  acceptedPayloads: ApplyPayload[];
  lookupProgress: LookupProgressState;
  setView: Dispatch<SetStateAction<PageView>>;
  setPhase: Dispatch<SetStateAction<Phase>>;
  setFolder: Dispatch<SetStateAction<string | null>>;
  setSettings: Dispatch<SetStateAction<AppSettings>>;
  setTracks: Dispatch<SetStateAction<ReviewTrack[]>>;
  setWorking: Dispatch<SetStateAction<ProposedTags | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setApplyOutcomes: Dispatch<SetStateAction<ApplyOutcome[] | null>>;
  setAcceptedPayloads: Dispatch<SetStateAction<ApplyPayload[]>>;
  setLookupProgress: Dispatch<SetStateAction<LookupProgressState>>;
};

export function useAutotagSession(args: UseAutotagSessionArgs) {
  const {
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
  } = args;
  const [savedSession, setSavedSession] = useState<SessionSnapshot | null>(null);
  const [resumeChecked, setResumeChecked] = useState(false);
  const autosaveTimerRef = useRef<number | null>(null);

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

  const applySnapshot = useCallback((snap: SessionSnapshot) => {
    setView(snap.view);
    setPhase(snap.phase);
    setFolder(snap.folder);
    setSettings(snap.settings);
    saveSettings(snap.settings);
    const migratedTracks = snap.tracks.map((t) =>
      t.confidenceScore != null
        ? t
        : { ...t, confidenceScore: t.confidence === "high" ? 85 : t.confidence === "medium" ? 50 : 10 },
    );
    setTracks(migratedTracks);
    setWorking(snap.working);
    setError(snap.error);
    setApplyOutcomes(snap.applyOutcomes);
    setAcceptedPayloads(snap.acceptedPayloads);
    setLookupProgress(snap.lookupProgress);
  }, [
    setAcceptedPayloads,
    setApplyOutcomes,
    setError,
    setFolder,
    setLookupProgress,
    setPhase,
    setSettings,
    setTracks,
    setView,
    setWorking,
  ]);

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
    }, 2000);
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

  return { savedSession, setSavedSession, resumeChecked, applySnapshot };
}
