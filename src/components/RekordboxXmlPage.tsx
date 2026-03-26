import { open } from "@tauri-apps/plugin-dialog";
import { useMemo, useState } from "react";
import { applyRekordboxBatch, matchRekordboxLibrary, scanFolder } from "../api/tauri";
import type { CleaningOptions } from "../options/types";
import type {
  ApplyOutcome,
  RekordboxApplyPayload,
  RekordboxMatchSummary,
  RekordboxWriteOptions,
  ScannedTrack,
} from "../types";

type Props = {
  cleaning: CleaningOptions;
  onBack: () => void;
};

const DEFAULT_OPTIONS: RekordboxWriteOptions = {
  writeBpm: true,
  writeKey: true,
  writeRating: true,
  writePlayCounter: false,
  writeComment: true,
  appendPlayCountToComment: false,
  writeRemixer: true,
  writeLabel: true,
  writeGenre: true,
  writeGrouping: true,
  writeTrackNumber: true,
  writeDiscNumber: true,
  writeYear: true,
  writeArtistTitleAlbum: false,
};

const OPTION_LABELS: Record<keyof RekordboxWriteOptions, string> = {
  writeBpm: "BPM",
  writeKey: "Key",
  writeRating: "Rating",
  writePlayCounter: "Play count",
  writeComment: "Comment",
  appendPlayCountToComment: "Append play count to comment",
  writeRemixer: "Remixer",
  writeLabel: "Label",
  writeGenre: "Genre",
  writeGrouping: "Grouping",
  writeTrackNumber: "Track number",
  writeDiscNumber: "Disc number",
  writeYear: "Year",
  writeArtistTitleAlbum: "Artist / Title / Album",
};

export function RekordboxXmlPage({ cleaning, onBack }: Props) {
  const [xmlPath, setXmlPath] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [scanned, setScanned] = useState<ScannedTrack[]>([]);
  const [summary, setSummary] = useState<RekordboxMatchSummary | null>(null);
  const [options, setOptions] = useState<RekordboxWriteOptions>(DEFAULT_OPTIONS);
  const [applyOutcomes, setApplyOutcomes] = useState<ApplyOutcome[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payloads = useMemo<RekordboxApplyPayload[]>(
    () =>
      (summary?.matches ?? [])
        .filter((m) => m.rekordbox)
        .map((m) => {
          const rb = m.rekordbox!;
          return {
            path: m.path,
            name: rb.name,
            artist: rb.artist,
            album: rb.album,
            grouping: rb.grouping,
            genre: rb.genre,
            averageBpm: rb.averageBpm,
            tonality: rb.tonality,
            rating: rb.rating,
            comments: rb.comments,
            remixer: rb.remixer,
            label: rb.label,
            trackNumber: rb.trackNumber,
            discNumber: rb.discNumber,
            year: rb.year,
            playCount: rb.playCount,
          };
        }),
    [summary],
  );

  const pickXml = async () => {
    if (busy) return;
    const f = await open({
      multiple: false,
      filters: [{ name: "XML", extensions: ["xml"] }],
    });
    if (!f || Array.isArray(f)) return;
    setXmlPath(f);
    setSummary(null);
    setApplyOutcomes(null);
  };

  const pickFolder = async () => {
    if (busy) return;
    const dir = await open({ directory: true, multiple: false });
    if (!dir || Array.isArray(dir)) return;
    setFolder(dir);
    setSummary(null);
    setApplyOutcomes(null);
    setBusy(true);
    setError(null);
    try {
      const result = await scanFolder(dir, cleaning);
      setScanned(result.tracks);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const runMatch = async () => {
    if (!xmlPath || scanned.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setApplyOutcomes(null);
    try {
      const out = await matchRekordboxLibrary(
        xmlPath,
        scanned.map((t) => t.path),
      );
      setSummary(out);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const runApply = async () => {
    if (payloads.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await applyRekordboxBatch(payloads, options);
      setApplyOutcomes(out);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <div className="tool-header">
        <h2>Rekordbox XML import/export</h2>
        <button type="button" className="btn btn-secondary" onClick={onBack}>
          Back to home
        </button>
      </div>
      <p className="muted">
        Import Rekordbox XML, match against local files, then apply selected Rekordbox fields.
      </p>
      <div className="row">
        <button type="button" className="btn" onClick={pickXml} disabled={busy}>
          Choose XML
        </button>
        <button type="button" className="btn" onClick={pickFolder} disabled={busy}>
          Choose music folder
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={runMatch}
          disabled={busy || !xmlPath || scanned.length === 0}
        >
          Match XML to files
        </button>
      </div>
      {xmlPath && <p className="muted">XML: {xmlPath}</p>}
      {folder && <p className="muted">Folder: {folder}</p>}
      {error && <div className="banner error">{error}</div>}

      {summary && (
        <section className="panel panel-accent">
          <p className="apply-panel-lead">
            Matched <strong>{summary.matchedCount}</strong> / {summary.scannedPaths} scanned files
            against {summary.rekordboxTracksInXml} Rekordbox XML tracks.
          </p>
          <div className="tool-options-grid">
            {Object.entries(options).map(([key, value]) => (
              <label key={key} className="check">
                <input
                  type="checkbox"
                  checked={Boolean(value)}
                  onChange={(e) =>
                    setOptions((prev) => ({
                      ...prev,
                      [key]: e.target.checked,
                    }))
                  }
                />
                {OPTION_LABELS[key as keyof RekordboxWriteOptions]}
              </label>
            ))}
          </div>
          <div className="row">
            <button
              type="button"
              className="btn primary"
              onClick={runApply}
              disabled={busy || payloads.length === 0}
            >
              Apply Rekordbox to matched files ({payloads.length})
            </button>
          </div>
        </section>
      )}

      {applyOutcomes && (
        <section className="panel panel-accent">
          <h3 className="panel-title">Apply outcomes</h3>
          <ul className="outcomes">
            {applyOutcomes.map((o) => (
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
