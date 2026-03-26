import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { loadSessionSnapshot, saveSessionSnapshot } from "../api/tauri";
import { saveSettings } from "../options/storage";
import type { AppSettings } from "../options/types";
import type { ApplyPayload, ProposedTags, ReviewTrack } from "../types";

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
  applyOutcomes: { path: string; ok: boolean; error: string | null }[] | null;
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
  applyOutcomes: { path: string; ok: boolean; error: string | null }[] | null;
  acceptedPayloads: ApplyPayload[];
  lookupProgress: LookupProgressState;
  setView: Dispatch<SetStateAction<PageView>>;
  setPhase: Dispatch<SetStateAction<Phase>>;
  setFolder: Dispatch<SetStateAction<string | null>>;
  setSettings: Dispatch<SetStateAction<AppSettings>>;
  setTracks: Dispatch<SetStateAction<ReviewTrack[]>>;
  setWorking: Dispatch<SetStateAction<ProposedTags | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setApplyOutcomes: Dispatch<SetStateAction<{ path: string; ok: boolean; error: string | null }[] | null>>;
  setAcceptedPayloads: Dispatch<SetStateAction<ApplyPayload[]>>;
  setLookupProgress: Dispatch<SetStateAction<LookupProgressState>>;
};

export function useAutotagSession(args: UseAutotagSessionArgs) {
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
    args.setView(snap.view);
    args.setPhase(snap.phase);
    args.setFolder(snap.folder);
    args.setSettings(snap.settings);
    saveSettings(snap.settings);
    args.setTracks(snap.tracks);
    args.setWorking(snap.working);
    args.setError(snap.error);
    args.setApplyOutcomes(snap.applyOutcomes);
    args.setAcceptedPayloads(snap.acceptedPayloads);
    args.setLookupProgress(snap.lookupProgress);
  }, [args]);

  useEffect(() => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = window.setTimeout(() => {
      const snapshot: SessionSnapshot = {
        view: args.view,
        phase: args.phase,
        folder: args.folder,
        settings: args.settings,
        tracks: args.tracks,
        working: args.working,
        error: args.error,
        applyOutcomes: args.applyOutcomes,
        acceptedPayloads: args.acceptedPayloads,
        lookupProgress: args.lookupProgress,
      };
      void saveSessionSnapshot(snapshot).then(() => setSavedSession(snapshot));
    }, 2000);
    return () => {
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current);
      }
    };
  }, [
    args.acceptedPayloads,
    args.applyOutcomes,
    args.error,
    args.folder,
    args.lookupProgress,
    args.phase,
    args.settings,
    args.tracks,
    args.view,
    args.working,
  ]);

  return { savedSession, setSavedSession, resumeChecked, applySnapshot };
}
