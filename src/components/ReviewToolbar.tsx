import type { Dispatch, SetStateAction } from "react";

type ProgressState = {
  active: boolean;
  done: number;
  total: number;
};

type BackgroundCoverLookupState = {
  active: boolean;
  done: number;
  total: number;
  workingOnCurrentFile: boolean;
};

type Props = {
  totalFiles: number;
  pendingCount: number;
  lookupProgress: ProgressState;
  backgroundCoverLookup: BackgroundCoverLookupState;
  coverProgressTotal: number;
  coverProgressDone: number;
  longTask: boolean;
  canReviewGoBack: boolean;
  onGoBackReview: () => void;
  onRunLookup: () => void;
  keywordSearch: string;
  setKeywordSearch: Dispatch<SetStateAction<string>>;
  onRunKeywordSearch: () => void;
  keywordSearchDisabled: boolean;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  lookupCurrentPath: string | null;
};

export function ReviewToolbar({
  totalFiles,
  pendingCount,
  lookupProgress,
  backgroundCoverLookup,
  coverProgressTotal,
  coverProgressDone,
  longTask,
  canReviewGoBack,
  onGoBackReview,
  onRunLookup,
  keywordSearch,
  setKeywordSearch,
  onRunKeywordSearch,
  keywordSearchDisabled,
  setSettingsOpen,
  lookupCurrentPath,
}: Props) {
  return (
    <section className="toolbar">
      <div className="toolbar-inner">
        <span className="stat stat-pill">
          <strong>{totalFiles}</strong> files
          <span className="stat-divider" aria-hidden="true" />
          <strong>{pendingCount}</strong> left
        </span>
        {lookupProgress.active && lookupProgress.total > 0 && (
          <div className="lookup-progress" aria-live="polite">
            <span className="lookup-progress-label">Lookup progress</span>
            <progress
              className="lookup-progress-bar"
              max={lookupProgress.total}
              value={Math.min(lookupProgress.done, lookupProgress.total)}
            />
            <span className="lookup-progress-text">
              {Math.min(lookupProgress.done, lookupProgress.total)} /{" "}
              {lookupProgress.total}
            </span>
          </div>
        )}
        {backgroundCoverLookup.active && backgroundCoverLookup.total > 0 && (
          <div className="lookup-progress lookup-progress-bg" aria-live="polite">
            <span className="lookup-progress-label">Background cover search</span>
            <progress
              className="lookup-progress-bar"
              max={backgroundCoverLookup.total}
              value={Math.min(
                backgroundCoverLookup.done,
                backgroundCoverLookup.total,
              )}
            />
            <span className="lookup-progress-text">
              {Math.min(backgroundCoverLookup.done, backgroundCoverLookup.total)}{" "}
              / {backgroundCoverLookup.total}
            </span>
          </div>
        )}
        {coverProgressTotal > 0 && (
          <div className="lookup-progress" aria-live="polite">
            <span className="lookup-progress-label">Covers loaded</span>
            <progress
              className="lookup-progress-bar"
              max={coverProgressTotal}
              value={Math.min(coverProgressDone, coverProgressTotal)}
            />
            <span className="lookup-progress-text">
              {Math.min(coverProgressDone, coverProgressTotal)} /{" "}
              {coverProgressTotal}
            </span>
          </div>
        )}
        <div className="toolbar-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onGoBackReview}
            disabled={longTask || !canReviewGoBack}
            title="Restore the last track you accepted or skipped"
            aria-label="Go back to previous track"
          >
            Back
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onRunLookup}
            disabled={longTask}
          >
            Re-run lookup
          </button>
          <input
            type="text"
            className="field-proposed"
            value={keywordSearch}
            onChange={(e) => setKeywordSearch(e.target.value)}
            placeholder="keywords (artist/title)"
            style={{ maxWidth: "16rem" }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !keywordSearchDisabled) {
                e.preventDefault();
                onRunKeywordSearch();
              }
            }}
          />
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onRunKeywordSearch}
            disabled={keywordSearchDisabled}
            title="Redo lookup for current track using typed keywords"
          >
            Redo search
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            data-no-review-refocus
            onClick={() => setSettingsOpen(true)}
          >
            Options
          </button>
        </div>
      </div>
      {lookupProgress.active && lookupCurrentPath && (
        <div className="muted" style={{ marginTop: "0.45rem", fontSize: "0.78rem" }}>
          Current lookup: {lookupCurrentPath}
        </div>
      )}
    </section>
  );
}
