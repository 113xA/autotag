import type { Dispatch, SetStateAction } from "react";
import type { ApplyOutcome } from "../types";

type Props = {
  applyOutcomes: ApplyOutcome[];
  onResetImport: () => void;
  setView: Dispatch<SetStateAction<"home" | "autotag" | "clean_names" | "rekordbox_xml">>;
};

export function ApplyDonePanel({ applyOutcomes, onResetImport, setView }: Props) {
  return (
    <section className="panel panel-done">
      <h2 className="panel-title">Apply finished</h2>
      <ul className="outcomes">
        {applyOutcomes.map((o) => {
          const shownPath = o.ok ? (o.finalPath ?? o.path) : o.path;
          const renamed = Boolean(
            o.ok && o.finalPath && o.finalPath !== o.path,
          );
          return (
            <li
              key={o.ok ? (o.finalPath ?? o.path) : o.path}
              className={o.ok ? "ok" : "bad"}
            >
              <span className="path">{shownPath}</span>
              {renamed && (
                <span className="muted"> was: {o.path}</span>
              )}
              {o.ok ? (
                <span>OK</span>
              ) : (
                <span className="err">{o.error}</span>
              )}
            </li>
          );
        })}
      </ul>
      <div className="apply-done-actions">
        <button type="button" className="btn primary" onClick={onResetImport}>
          New session
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setView("home")}
        >
          Back to home
        </button>
      </div>
    </section>
  );
}
