import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { batchLookup, musicbrainzLookupOne } from "../api/tauri";
import type { MatchingOptions } from "../options/types";
import type { ProposedTags, ReviewTrack } from "../types";

type MergeLookup = (results: {
  path: string;
  candidates: ReviewTrack["candidates"];
  confidence?: ReviewTrack["confidence"];
  artistGuesses?: string[];
}[]) => void;

type UseLookupActionsArgs = {
  matching: MatchingOptions;
  lookupRunIdRef: MutableRefObject<number>;
  setTracks: Dispatch<SetStateAction<ReviewTrack[]>>;
  setSingleLookupPath: Dispatch<SetStateAction<string | null>>;
  setError: (v: string | null) => void;
  mergeLookupResults: MergeLookup;
  current: ReviewTrack | undefined;
  working: ProposedTags | null;
};

export function useLookupActions({
  matching,
  lookupRunIdRef,
  setTracks,
  setSingleLookupPath,
  setError,
  mergeLookupResults,
  current,
  working,
}: UseLookupActionsArgs) {
  const bumpCandidate = useCallback((delta: number) => {
    const curPath = current?.path;
    if (!curPath) return;
    setTracks((ts) => {
      const active = ts.find(
        (t) => t.path === curPath && t.reviewStatus === "pending",
      );
      if (!active) return ts;
      return ts.map((t) => {
        if (t.path !== curPath) return t;
        const n = t.candidates.length;
        if (n === 0) return t;
        const next = (t.candidateIndex + delta + n) % n;
        return { ...t, candidateIndex: next };
      });
    });
  }, [current?.path, setTracks]);

  const rerunSingleLookup = useCallback(
    async (path: string, artist: string, title: string, filenameStem: string) => {
      setSingleLookupPath(path);
      try {
        const one = await batchLookup(
          [{ path, artist, title, filenameStem }],
          matching,
          lookupRunIdRef.current,
        );
        mergeLookupResults(one);
      } catch (e) {
        setError(String(e));
      } finally {
        setSingleLookupPath((prev) => (prev === path ? null : prev));
      }
    },
    [
      lookupRunIdRef,
      matching,
      mergeLookupResults,
      setError,
      setSingleLookupPath,
    ],
  );

  const rerunSingleMusicbrainz = useCallback(
    async (path: string, artist: string, title: string, filenameStem: string) => {
      setSingleLookupPath(path);
      try {
        const one = await musicbrainzLookupOne(
          { path, artist, title, filenameStem },
          matching,
        );
        mergeLookupResults([one]);
      } catch (e) {
        setError(String(e));
      } finally {
        setSingleLookupPath((prev) => (prev === path ? null : prev));
      }
    },
    [matching, mergeLookupResults, setError, setSingleLookupPath],
  );

  const handleGuessArtist = useCallback(
    (artistGuess: string) => {
      if (!current) return;
      const title = working?.title?.trim() || current.cleaned.searchTitle;
      void rerunSingleLookup(current.path, artistGuess, title, current.filenameStem);
    },
    [current, rerunSingleLookup, working?.title],
  );

  const handleMusicbrainzLookup = useCallback(() => {
    if (!current) return;
    const artist = working?.artist?.trim() || current.cleaned.searchArtist;
    const title = working?.title?.trim() || current.cleaned.searchTitle;
    void rerunSingleMusicbrainz(current.path, artist, title, current.filenameStem);
  }, [current, rerunSingleMusicbrainz, working?.artist, working?.title]);

  return {
    bumpCandidate,
    rerunSingleLookup,
    handleGuessArtist,
    handleMusicbrainzLookup,
  };
}
