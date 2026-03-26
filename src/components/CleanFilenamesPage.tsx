import { open } from "@tauri-apps/plugin-dialog";
import { useMemo, useState } from "react";
import { cleanRenameBatch, scanFolder } from "../api/tauri";
import type { CleaningOptions } from "../options/types";
import type { CleanRenameOutcome, ScannedTrack } from "../types";

type Props = {
  cleaning: CleaningOptions;
  onBack: () => void;
};

function extOf(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return i >= 0 ? fileName.slice(i) : "";
}

export function CleanFilenamesPage({ cleaning, onBack }: Props) {
  const [folder, setFolder] = useState<string | null>(null);
  const [tracks, setTracks] = useState<ScannedTrack[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<CleanRenameOutcome[] | null>(null);

  const selectedCount = selected.size;
  const canApply = selectedCount > 0 && !busy;

  const tableRows = useMemo(
    () =>
      tracks.map((t) => ({
        ...t,
        targetName: `${t.cleaned.display}${extOf(t.fileName)}`,
      })),
    [tracks],
  );

  const chooseFolder = async () => {
    if (busy) return;
    setError(null);
    setOutcomes(null);
    const dir = await open({ directory: true, multiple: false });
    if (dir === null || Array.isArray(dir)) return;
    setFolder(dir);
    setBusy(true);
    try {
      const scanned = await scanFolder(dir, cleaning);
      setTracks(scanned);
      setSelected(new Set(scanned.map((t) => t.path)));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const applyRename = async () => {
    if (!canApply) return;
    setBusy(true);
    setError(null);
    try {
      const items = tracks
        .filter((t) => selected.has(t.path))
        .map((t) => ({ path: t.path, cleanedDisplay: t.cleaned.display }));
      const result = await cleanRenameBatch(items);
      setOutcomes(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <div className="tool-header">
        <h2>Clean file names</h2>
        <button type="button" className="btn btn-secondary" onClick={onBack}>
          Back to home
        </button>
      </div>
      <p className="muted">
        Scan a folder using your filename cleaning settings, then rename selected files to cleaned titles.
      </p>
      <div className="row">
        <button type="button" className="btn primary" onClick={chooseFolder} disabled={busy}>
          Choose folder
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setSelected(new Set(tracks.map((t) => t.path)))}
          disabled={busy || tracks.length === 0}
        >
          Select all
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setSelected(new Set())}
          disabled={busy || tracks.length === 0}
        >
          Select none
        </button>
        <button type="button" className="btn primary" onClick={applyRename} disabled={!canApply}>
          Rename selected ({selectedCount})
        </button>
      </div>
      {folder && <p className="muted">Folder: {folder}</p>}
      {error && <div className="banner error">{error}</div>}

      <div className="file-table-wrap tool-table-wrap">
        <table className="file-table">
          <thead>
            <tr>
              <th />
              <th>Current file</th>
              <th>Path</th>
              <th>Cleaned target</th>
            </tr>
          </thead>
          <tbody>
            {tableRows.map((t) => (
              <tr key={t.path}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(t.path)}
                    onChange={() => toggle(t.path)}
                  />
                </td>
                <td className="mono">{t.fileName}</td>
                <td className="mono narrow-path">{t.path}</td>
                <td className="mono">{t.targetName}</td>
              </tr>
            ))}
            {tableRows.length === 0 && (
              <tr>
                <td colSpan={4}>No files loaded yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {outcomes && (
        <section className="panel panel-accent">
          <h3 className="panel-title">Rename outcomes</h3>
          <ul className="outcomes">
            {outcomes.map((o) => (
              <li key={o.path} className={o.ok ? "ok" : "bad"}>
                <span className="path">{o.path}</span>
                {o.ok ? <span>OK</span> : <span className="err">{o.error}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
