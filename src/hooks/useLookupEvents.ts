import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, type MutableRefObject } from "react";
import type { ReviewTrack } from "../types";

type LookupResultEventPayload = {
  run_id: number;
  result: {
    path: string;
    candidates: ReviewTrack["candidates"];
    confidence?: ReviewTrack["confidence"];
    artistGuesses?: string[];
  };
};

type MergeLookup = (results: {
  path: string;
  candidates: ReviewTrack["candidates"];
  confidence?: ReviewTrack["confidence"];
  artistGuesses?: string[];
}[]) => void;

export function useLookupEvents(
  mergeLookupResults: MergeLookup,
  lookupRunIdRef: MutableRefObject<number>,
  verboseLogs: boolean,
) {
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void (async () => {
      unlisten = await listen<LookupResultEventPayload>("lookup_result", (e) => {
        const payload = e.payload;
        if (payload.run_id !== lookupRunIdRef.current) return;
        if (verboseLogs) {
          const firstCoverOpts = payload.result.candidates[0]?.coverOptions?.length ?? 0;
          console.debug("[lookup_result]", {
            path: payload.result.path,
            candidates: payload.result.candidates.length,
            firstCoverOpts,
          });
        }
        mergeLookupResults([payload.result]);
      });
      if (cancelled) {
        unlisten();
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [lookupRunIdRef, mergeLookupResults, verboseLogs]);
}
