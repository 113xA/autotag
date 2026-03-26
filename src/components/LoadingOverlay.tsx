import { useEffect, useRef } from "react";
import type { ProgressPayload } from "../options/types";

const LABELS: Record<ProgressPayload["kind"], string> = {
  scan: "Scanning library…",
  lookup: "MusicBrainz lookup…",
  apply: "Writing tags and files…",
  rekordbox: "Writing Rekordbox metadata…",
};

type Props = {
  open: boolean;
  progress: ProgressPayload | null;
};

export function LoadingOverlay({ open, progress }: Props) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const prevActiveRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    prevActiveRef.current = document.activeElement;
    const node = overlayRef.current;
    node?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      e.preventDefault();
      node?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (prevActiveRef.current instanceof HTMLElement) {
        prevActiveRef.current.focus();
      }
    };
  }, [open]);

  if (!open) return null;
  const rawKind = progress?.kind ?? "scan";
  const kind: ProgressPayload["kind"] =
    rawKind === "scan" ||
    rawKind === "lookup" ||
    rawKind === "apply" ||
    rawKind === "rekordbox"
      ? rawKind
      : "scan";
  const total = progress?.total ?? 0;
  const done = progress?.done ?? 0;
  const hasTotal = total > 0;
  const pct = hasTotal ? Math.min(100, Math.round((done / total) * 100)) : null;
  const sub =
    progress?.message ?? (hasTotal ? `${done} / ${total}` : null);
  const title = LABELS[kind] ?? "Working…";
  const indeterminate = !hasTotal;

  return (
    <div
      className="loading-overlay"
      role="alertdialog"
      aria-busy="true"
      aria-modal="true"
      aria-labelledby="loading-overlay-title"
      tabIndex={-1}
      ref={overlayRef}
    >
      <div className="loading-card">
        <h2 id="loading-overlay-title" className="loading-title">{title}</h2>
        {sub && <p className="loading-sub">{sub}</p>}
        {indeterminate ? (
          <progress className="loading-bar loading-bar-indeterminate" />
        ) : (
          <progress className="loading-bar" max={total} value={done} />
        )}
        {pct !== null && <p className="loading-pct">{pct}%</p>}
      </div>
    </div>
  );
}
