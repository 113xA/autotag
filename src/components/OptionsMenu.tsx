import { EDM_PRESETS, GENRE_SUGGESTIONS, applyPreset } from "../options/presets";
import type { AppSettings } from "../options/types";

type Props = {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  open: boolean;
  onClose: () => void;
};

export function OptionsMenu({ settings, onChange, open, onClose }: Props) {
  if (!open) return null;

  const s = settings;

  return (
    <>
      <button
        type="button"
        className="options-backdrop"
        aria-label="Close settings"
        onClick={onClose}
      />
      <aside className="options-drawer" aria-label="Settings">
        <div className="options-drawer-head">
          <h2>Settings</h2>
          <button type="button" className="btn btn-ghost icon-close" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="options-scroll">
          <section className="opt-section">
            <h3>EDM presets</h3>
            <p className="opt-hint">
              Sets MusicBrainz tag bias and a default genre suggestion. Tune advanced
              fields below anytime.
            </p>
            <div className="preset-grid">
              {Object.entries(EDM_PRESETS).map(([id, { label }]) => (
                <button
                  key={id}
                  type="button"
                  className="btn preset-chip"
                  onClick={() => onChange(applyPreset(id, s))}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>

          <section className="opt-section">
            <h3>Workflow</h3>
            <label className="check">
              <input
                type="checkbox"
                checked={s.autoLookupOnImport}
                onChange={(e) =>
                  onChange({ ...s, autoLookupOnImport: e.target.checked })
                }
              />
              Auto MusicBrainz lookup after scan
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={s.renameOnApply}
                onChange={(e) =>
                  onChange({ ...s, renameOnApply: e.target.checked })
                }
              />
              Rename files on apply (Artist - Title.ext)
            </label>
          </section>

          <section className="opt-section">
            <h3>Filename cleaning</h3>
            <label className="check">
              <input
                type="checkbox"
                checked={s.cleaning.stripPromoParens}
                onChange={(e) =>
                  onChange({
                    ...s,
                    cleaning: {
                      ...s.cleaning,
                      stripPromoParens: e.target.checked,
                    },
                  })
                }
              />
              Strip promo sites in (parentheses)
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={s.cleaning.underscoresToSpaces}
                onChange={(e) =>
                  onChange({
                    ...s,
                    cleaning: {
                      ...s.cleaning,
                      underscoresToSpaces: e.target.checked,
                    },
                  })
                }
              />
              Underscores to spaces
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={s.cleaning.collapseWhitespace}
                onChange={(e) =>
                  onChange({
                    ...s,
                    cleaning: {
                      ...s.cleaning,
                      collapseWhitespace: e.target.checked,
                    },
                  })
                }
              />
              Collapse extra spaces
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={s.cleaning.normalizeFeat}
                onChange={(e) =>
                  onChange({
                    ...s,
                    cleaning: { ...s.cleaning, normalizeFeat: e.target.checked },
                  })
                }
              />
              Normalize ft. / vs.
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={s.cleaning.stripNoiseTokens}
                onChange={(e) =>
                  onChange({
                    ...s,
                    cleaning: { ...s.cleaning, stripNoiseTokens: e.target.checked },
                  })
                }
              />
              Strip DJ mix noise from titles (search)
            </label>
            {s.cleaning.stripNoiseTokens && (
              <div className="opt-nested">
                {(
                  [
                    ["noiseExtendedMix", "Extended / Extended Mix"],
                    ["noiseVip", "VIP"],
                    ["noiseRadioEdit", "Radio edit"],
                    ["noiseBootleg", "Bootleg"],
                    ["noiseMashup", "Mashup"],
                    ["noiseRemixEdit", "Club / dub / instrumental…"],
                  ] as const
                ).map(([key, lab]) => (
                  <label key={key} className="check small">
                    <input
                      type="checkbox"
                      checked={s.cleaning[key]}
                      onChange={(e) =>
                        onChange({
                          ...s,
                          cleaning: { ...s.cleaning, [key]: e.target.checked },
                        })
                      }
                    />
                    {lab}
                  </label>
                ))}
              </div>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={s.cleaning.searchOnlyExtraStrip}
                onChange={(e) =>
                  onChange({
                    ...s,
                    cleaning: {
                      ...s.cleaning,
                      searchOnlyExtraStrip: e.target.checked,
                    },
                  })
                }
              />
              Noise strip for search only (keep longer display text)
            </label>
            <label className="field">
              <span>Artist / title split</span>
              <select
                value={s.cleaning.splitRule}
                onChange={(e) =>
                  onChange({
                    ...s,
                    cleaning: {
                      ...s.cleaning,
                      splitRule: e.target.value as AppSettings["cleaning"]["splitRule"],
                    },
                  })
                }
              >
                <option value="firstDash">First “ - ”</option>
                <option value="lastDash">Last “ - ” (multi-artist)</option>
              </select>
            </label>
          </section>

          <section className="opt-section">
            <h3>Matching (MusicBrainz)</h3>
            <label className="field">
              <span>Max results</span>
              <input
                type="number"
                min={1}
                max={25}
                value={s.matching.limit}
                onChange={(e) =>
                  onChange({
                    ...s,
                    matching: {
                      ...s.matching,
                      limit: Math.min(25, Math.max(1, +e.target.value || 8)),
                    },
                  })
                }
              />
            </label>
            <label className="field block">
              <span>Tag bias (Lucene fragment, optional)</span>
              <textarea
                rows={3}
                className="opt-textarea"
                value={s.matching.tagBias}
                onChange={(e) =>
                  onChange({
                    ...s,
                    matching: { ...s.matching, tagBias: e.target.value },
                  })
                }
                placeholder='e.g. tag:techno OR tag:electronic'
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={s.matching.fallbackRecordingOnly}
                onChange={(e) =>
                  onChange({
                    ...s,
                    matching: {
                      ...s.matching,
                      fallbackRecordingOnly: e.target.checked,
                    },
                  })
                }
              />
              Fallback: recording-only query if empty
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={s.matching.fallbackStripParens}
                onChange={(e) =>
                  onChange({
                    ...s,
                    matching: {
                      ...s.matching,
                      fallbackStripParens: e.target.checked,
                    },
                  })
                }
              />
              Fallback: strip ( ) / [ ] from title and retry
            </label>
          </section>

          <section className="opt-section">
            <h3>Metadata on apply</h3>
            <label className="check">
              <input
                type="checkbox"
                checked={s.applyMeta.writeTags}
                onChange={(e) =>
                  onChange({
                    ...s,
                    applyMeta: { ...s.applyMeta, writeTags: e.target.checked },
                  })
                }
              />
              Write tags (artist, title, album, …)
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={s.applyMeta.embedCover}
                onChange={(e) =>
                  onChange({
                    ...s,
                    applyMeta: { ...s.applyMeta, embedCover: e.target.checked },
                  })
                }
              />
              Embed front cover art
            </label>
            <label className="field">
              <span>Genre</span>
              <input
                list="genre-suggestions"
                value={s.applyMeta.genre ?? ""}
                onChange={(e) =>
                  onChange({
                    ...s,
                    applyMeta: {
                      ...s.applyMeta,
                      genre: e.target.value.trim() || null,
                    },
                  })
                }
                placeholder="Leave empty to clear on write"
              />
              <datalist id="genre-suggestions">
                {GENRE_SUGGESTIONS.filter(Boolean).map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </label>
            <label className="field block">
              <span>Grouping (optional)</span>
              <input
                value={s.applyMeta.grouping ?? ""}
                onChange={(e) =>
                  onChange({
                    ...s,
                    applyMeta: {
                      ...s.applyMeta,
                      grouping: e.target.value.trim() || null,
                    },
                  })
                }
              />
            </label>
            <label className="field block">
              <span>Comment (optional)</span>
              <textarea
                rows={2}
                className="opt-textarea"
                value={s.applyMeta.comment ?? ""}
                onChange={(e) =>
                  onChange({
                    ...s,
                    applyMeta: {
                      ...s.applyMeta,
                      comment: e.target.value.trim() || null,
                    },
                  })
                }
              />
            </label>
          </section>
        </div>
      </aside>
    </>
  );
}
