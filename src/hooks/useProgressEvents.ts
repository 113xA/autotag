import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import type { ProgressPayload } from "../options/types";

function normalizeKind(raw: string): ProgressPayload["kind"] {
  if (raw === "lookup" || raw === "apply" || raw === "rekordbox") return raw;
  return "scan";
}

export function useProgressEvents(active: boolean) {
  const [progress, setProgress] = useState<ProgressPayload | null>(null);

  const clearProgress = useCallback(() => {
    setProgress(null);
  }, []);

  useEffect(() => {
    if (!active) {
      setProgress(null);
      return;
    }

    let cancelled = false;
    let unlisten: UnlistenFn | undefined;

    void (async () => {
      try {
        unlisten = await listen<ProgressPayload>("progress", (e) => {
          const p = e.payload;
          setProgress({
            kind: normalizeKind(String(p.kind)),
            done: p.done,
            total: p.total,
            message: p.message ?? null,
          });
        });
        if (cancelled) {
          unlisten();
          unlisten = undefined;
        }
      } catch {
        /* listen failed (e.g. non-Tauri); ignore */
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [active]);

  return { progress, clearProgress };
}
