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

type Args = {
  matching: MatchingOptions;
  lookupRunIdRef: MutableRefObject<number>;
  setTracks: Dispatch<SetStateAction<ReviewTrack[]>>;
  setSingleLookupPath: Dispatch<SetStateAction<string | null>>;
  setError: (v: string | null) => void;
  mergeLookupResults: MergeLookup;
  current: ReviewTrack | undefined;
  working: ProposedTags | null;
};

export function useLookupActions(args: Args) {
  const bumpCandidate = useCallback((delta: number) => {
    args.setTracks((ts) => {
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
  }, [args]);

  const rerunSingleLookup = useCallback(
    async (path: string, artist: string, title: string, filenameStem: string) => {
      args.setSingleLookupPath(path);
      try {
        const one = await batchLookup(
          [{ path, artist, title, filenameStem }],
          args.matching,
          args.lookupRunIdRef.current,
        );
        args.mergeLookupResults(one);
      } catch (e) {
        args.setError(String(e));
      } finally {
        args.setSingleLookupPath((prev) => (prev === path ? null : prev));
      }
    },
    [args],
  );

  const rerunSingleMusicbrainz = useCallback(
    async (path: string, artist: string, title: string, filenameStem: string) => {
      args.setSingleLookupPath(path);
      try {
        const one = await musicbrainzLookupOne(
          { path, artist, title, filenameStem },
          args.matching,
        );
        args.mergeLookupResults([one]);
      } catch (e) {
        args.setError(String(e));
      } finally {
        args.setSingleLookupPath((prev) => (prev === path ? null : prev));
      }
    },
    [args],
  );

  const handleGuessArtist = useCallback(
    (artistGuess: string) => {
      if (!args.current) return;
      const title = args.working?.title?.trim() || args.current.cleaned.searchTitle;
      void rerunSingleLookup(args.current.path, artistGuess, title, args.current.filenameStem);
    },
    [args.current, args.working?.title, rerunSingleLookup],
  );

  const handleMusicbrainzLookup = useCallback(() => {
    if (!args.current) return;
    const artist = args.working?.artist?.trim() || args.current.cleaned.searchArtist;
    const title = args.working?.title?.trim() || args.current.cleaned.searchTitle;
    void rerunSingleMusicbrainz(args.current.path, artist, title, args.current.filenameStem);
  }, [args.current, args.working?.artist, args.working?.title, rerunSingleMusicbrainz]);

  return {
    bumpCandidate,
    rerunSingleLookup,
    handleGuessArtist,
    handleMusicbrainzLookup,
  };
}
