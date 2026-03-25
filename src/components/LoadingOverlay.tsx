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
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const sub =
    progress?.message ??
    (total > 0 ? `${done} / ${total}` : null);
  const title = LABELS[kind] ?? "Working…";

  return (
    <div className="loading-overlay" role="alertdialog" aria-busy="true">
      <div className="loading-card">
        <h2 className="loading-title">{title}</h2>
        {sub && <p className="loading-sub">{sub}</p>}
        <progress
          className="loading-bar"
          max={total > 0 ? total : 100}
          value={total > 0 ? done : pct}
        />
        {total > 0 && (
          <p className="loading-pct">{pct}%</p>
        )}
      </div>
    </div>
  );
}
