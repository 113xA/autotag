import { useEffect, useRef, useState } from "react";
import { previewRename, spotifyAuth, spotifyAuthBrowser } from "../api/tauri";
import { EDM_PRESETS, GENRE_SUGGESTIONS, applyPreset } from "../options/presets";
import type { AppSettings, RenameSeparator, RenameSettings } from "../options/types";

const RENAME_PREVIEW_PATH = "C:\\Music\\example track.mp3";
const SPOTIFY_REDIRECT_URI = "http://127.0.0.1:43857/callback";

type Props = {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  open: boolean;
  onClose: () => void;
};

export function OptionsMenu({ settings, onChange, open, onClose }: Props) {
  const [renameExample, setRenameExample] = useState<string | null>(null);
  const [spotifyStatus, setSpotifyStatus] = useState<string | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement;
    const r = settings.rename;
    if (!r.enabled) {
      setRenameExample(null);
      return;
    }
    let cancel = false;
    previewRename(
      RENAME_PREVIEW_PATH,
      "Artist One",
      "Track Title",
      "Album Name",
      2024,
      r,
    )
      .then((name) => {
        if (!cancel) setRenameExample(name);
      })
      .catch(() => {
        if (!cancel) setRenameExample(null);
      });
    return () => {
      cancel = true;
    };
  }, [open, settings.rename]);

  useEffect(() => {
    if (!open) {
      if (previousFocusRef.current instanceof HTMLElement) {
        previousFocusRef.current.focus();
      } else {
        const settingsBtn = document.querySelector(".settings-btn");
        if (settingsBtn instanceof HTMLElement) settingsBtn.focus();
      }
      return;
    }
    drawerRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab") {
        const root = drawerRef.current;
        if (!root) return;
        const focusables = root.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) {
          e.preventDefault();
          root.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const s = settings;

  const renamePartsInvalid =
    s.rename.enabled &&
    !s.rename.includeArtist &&
    !s.rename.includeTitle &&
    !s.rename.includeAlbum;

  function patchRename(next: Partial<RenameSettings>) {
    onChange({ ...s, rename: { ...s.rename, ...next } });
  }

  return (
    <>
      <button
        type="button"
        className="options-backdrop"
        aria-label="Close settings"
        onClick={onClose}
      />
      <aside
        className="options-drawer"
        aria-label="Settings"
        aria-modal="true"
        tabIndex={-1}
        ref={drawerRef}
      >
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
            <div className="preset-summary" aria-live="polite">
              <div className="preset-summary-row">
                <span className="preset-summary-label">Tag bias</span>
                <span className="preset-summary-value mono">
                  {s.matching.tagBias.trim()
                    ? s.matching.tagBias
                    : "None (wider MusicBrainz matches)"}
                </span>
              </div>
              <div className="preset-summary-row">
                <span className="preset-summary-label">Genre on apply</span>
                <span className="preset-summary-value">
                  {s.applyMeta.genre?.trim() || "—"}
                </span>
              </div>
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
            <p className="opt-hint" style={{ marginTop: "0.5rem" }}>
              File rename rules are in <strong>File naming</strong> below.
            </p>
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
            <label className="check">
              <input
                type="checkbox"
                checked={s.matching.useItunesFilenameHints}
                onChange={(e) =>
                  onChange({
                    ...s,
                    matching: {
                      ...s.matching,
                      useItunesFilenameHints: e.target.checked,
                    },
                  })
                }
              />
              iTunes filename hints (stem sent to Apple search)
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={s.matching.useDeezer}
                onChange={(e) =>
                  onChange({
                    ...s,
                    matching: {
                      ...s.matching,
                      useDeezer: e.target.checked,
                    },
                  })
                }
              />
              Deezer search hints (free API)
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={s.matching.useSpotify}
                onChange={(e) =>
                  onChange({
                    ...s,
                    matching: {
                      ...s.matching,
                      useSpotify: e.target.checked,
                    },
                  })
                }
              />
              Spotify hints (requires login below)
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={s.matching.useAmazon}
                onChange={(e) =>
                  onChange({
                    ...s,
                    matching: {
                      ...s.matching,
                      useAmazon: e.target.checked,
                    },
                  })
                }
              />
              Amazon cover hints (public product search)
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={s.matching.useYoutube}
                onChange={(e) =>
                  onChange({
                    ...s,
                    matching: {
                      ...s.matching,
                      useYoutube: e.target.checked,
                    },
                  })
                }
              />
              YouTube fallback hints (videos/topic metadata)
            </label>
            <label className="field block">
              <span>Spotify client ID (optional)</span>
              <input
                value={s.spotifyClientId ?? ""}
                onChange={(e) =>
                  onChange({
                    ...s,
                    spotifyClientId: e.target.value.trim() || null,
                  })
                }
                placeholder="Spotify app client ID"
              />
            </label>
            <label className="field block">
              <span>Spotify client secret (optional)</span>
              <input
                type="password"
                value={s.spotifyClientSecret ?? ""}
                onChange={(e) =>
                  onChange({
                    ...s,
                    spotifyClientSecret: e.target.value.trim() || null,
                  })
                }
                placeholder="Spotify app client secret"
              />
            </label>
            <div className="opt-hint" style={{ marginBottom: "0.45rem" }}>
              <strong>Quick setup (recommended)</strong>
              <br />
              1) In Spotify Developer Dashboard, open your app and add redirect URI:
              <br />
              <code className="mono">{SPOTIFY_REDIRECT_URI}</code>
              <br />
              2) Paste your Client ID above
              <br />
              3) Click <strong>Connect Spotify (browser)</strong> and approve
              <br />
              4) Enable <strong>Spotify hints</strong> to use results in matching
            </div>
            <div className="row">
              <button
                type="button"
                className="btn"
                disabled={!(s.spotifyClientId ?? "").trim()}
                onClick={async () => {
                  setSpotifyStatus(null);
                  try {
                    const out = await spotifyAuthBrowser(s.spotifyClientId ?? "");
                    setSpotifyStatus(
                      out.ok
                        ? `Spotify connected in browser (${out.expiresIn}s token)`
                        : "Spotify browser auth failed",
                    );
                  } catch (e) {
                    setSpotifyStatus(`Spotify browser auth failed: ${String(e)}`);
                  }
                }}
              >
                Connect Spotify (browser)
              </button>
              <button
                type="button"
                className="btn"
                disabled={
                  !(s.spotifyClientId ?? "").trim() ||
                  !(s.spotifyClientSecret ?? "").trim()
                }
                onClick={async () => {
                  setSpotifyStatus(null);
                  try {
                    const out = await spotifyAuth(
                      s.spotifyClientId ?? "",
                      s.spotifyClientSecret ?? "",
                    );
                    setSpotifyStatus(
                      out.ok ? `Spotify connected (${out.expiresIn}s token)` : "Spotify auth failed",
                    );
                  } catch (e) {
                    setSpotifyStatus(`Spotify auth failed: ${String(e)}`);
                  }
                }}
              >
                Connect Spotify (client secret)
              </button>
            </div>
            {!(s.spotifyClientId ?? "").trim() && (
              <p className="opt-hint">
                Add your Spotify Client ID first, then use browser connect.
              </p>
            )}
            {spotifyStatus && <p className="opt-hint">{spotifyStatus}</p>}
          </section>

          <section className="opt-section opt-section-danger">
            <h3>Dev options</h3>
            <p className="opt-hint">
              Debug-only options. Can produce a lot of terminal/browser logs.
            </p>
            <label className="check">
              <input
                type="checkbox"
                checked={s.matching.verboseLogs}
                onChange={(e) =>
                  onChange({
                    ...s,
                    matching: {
                      ...s.matching,
                      verboseLogs: e.target.checked,
                    },
                  })
                }
              />
              Verbose console logs (frontend + Rust backend)
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
            <label className="check">
              <input
                type="checkbox"
                checked={s.applyMeta.tryItunesCoverFallback}
                onChange={(e) =>
                  onChange({
                    ...s,
                    applyMeta: {
                      ...s.applyMeta,
                      tryItunesCoverFallback: e.target.checked,
                    },
                  })
                }
              />
              Try iTunes artwork if MusicBrainz has no cover (sends artist and
              title to Apple’s public search)
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={s.applyMeta.embedPlaceholderWhenNoArt}
                onChange={(e) =>
                  onChange({
                    ...s,
                    applyMeta: {
                      ...s.applyMeta,
                      embedPlaceholderWhenNoArt: e.target.checked,
                    },
                  })
                }
              />
              Embed placeholder image when no art is found (with embed cover on)
            </label>
            <label className="field">
              <span>Genre</span>
              <select
                className="genre-quick-select"
                value={
                  GENRE_SUGGESTIONS.filter(Boolean).includes(
                    (s.applyMeta.genre ?? "").trim(),
                  )
                    ? (s.applyMeta.genre ?? "").trim()
                    : ""
                }
                onChange={(e) =>
                  onChange({
                    ...s,
                    applyMeta: {
                      ...s.applyMeta,
                      genre: e.target.value.trim() || null,
                    },
                  })
                }
              >
                <option value="">Quick pick…</option>
                {GENRE_SUGGESTIONS.filter(Boolean).map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
              <input
                className="genre-custom-input"
                value={s.applyMeta.genre ?? ""}
                onChange={(e) =>
                  onChange({
                    ...s,
                    applyMeta: {
                      ...s.applyMeta,
                      genre: e.target.value,
                    },
                  })
                }
                onBlur={(e) =>
                  onChange({
                    ...s,
                    applyMeta: {
                      ...s.applyMeta,
                      genre: e.target.value.trim() || null,
                    },
                  })
                }
                placeholder="Type any genre (used on apply; overrides quick pick when different)"
              />
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

          <section className="opt-section">
            <h3>File naming</h3>
            <p className="opt-hint">
              Applied when you accept tracks and run apply. Year is appended as{" "}
              <span className="mono">(2024)</span> when enabled.
            </p>

            <div className="toggle-master">
              <span id="rename-master-label">Rename files on apply</span>
              <button
                type="button"
                role="switch"
                aria-labelledby="rename-master-label"
                aria-checked={s.rename.enabled}
                className={`toggle-switch ${s.rename.enabled ? "on" : ""}`}
                onClick={() => patchRename({ enabled: !s.rename.enabled })}
              >
                <span className="toggle-knob" />
              </button>
            </div>

            <fieldset
              className="rename-fieldset"
              disabled={!s.rename.enabled}
            >
              <div className="toggle-row">
                <span id="sw-artist">Artist</span>
                <button
                  type="button"
                  role="switch"
                  aria-labelledby="sw-artist"
                  aria-checked={s.rename.includeArtist}
                  className={`toggle-switch ${s.rename.includeArtist ? "on" : ""}`}
                  onClick={() =>
                    patchRename({ includeArtist: !s.rename.includeArtist })
                  }
                >
                  <span className="toggle-knob" />
                </button>
              </div>
              <div className="toggle-row">
                <span id="sw-title">Title</span>
                <button
                  type="button"
                  role="switch"
                  aria-labelledby="sw-title"
                  aria-checked={s.rename.includeTitle}
                  className={`toggle-switch ${s.rename.includeTitle ? "on" : ""}`}
                  onClick={() =>
                    patchRename({ includeTitle: !s.rename.includeTitle })
                  }
                >
                  <span className="toggle-knob" />
                </button>
              </div>
              <div className="toggle-row">
                <span id="sw-album">Album</span>
                <button
                  type="button"
                  role="switch"
                  aria-labelledby="sw-album"
                  aria-checked={s.rename.includeAlbum}
                  className={`toggle-switch ${s.rename.includeAlbum ? "on" : ""}`}
                  onClick={() =>
                    patchRename({ includeAlbum: !s.rename.includeAlbum })
                  }
                >
                  <span className="toggle-knob" />
                </button>
              </div>
              <div className="toggle-row">
                <span id="sw-year">Year suffix</span>
                <button
                  type="button"
                  role="switch"
                  aria-labelledby="sw-year"
                  aria-checked={s.rename.includeYear}
                  className={`toggle-switch ${s.rename.includeYear ? "on" : ""}`}
                  onClick={() =>
                    patchRename({ includeYear: !s.rename.includeYear })
                  }
                >
                  <span className="toggle-knob" />
                </button>
              </div>

              <label className="field">
                <span>Separator between parts</span>
                <select
                  value={s.rename.separator}
                  onChange={(e) =>
                    patchRename({
                      separator: e.target.value as RenameSeparator,
                    })
                  }
                >
                  <option value="dashSpaced">Space – space ( - )</option>
                  <option value="dashTight">Hyphen (-)</option>
                  <option value="underscore">Underscore (_)</option>
                  <option value="dot">Middle dot (·)</option>
                </select>
              </label>

              <label className="field">
                <span>Order (artist &amp; title)</span>
                <select
                  value={s.rename.partOrder}
                  onChange={(e) =>
                    patchRename({
                      partOrder: e.target.value as "artistFirst" | "titleFirst",
                    })
                  }
                >
                  <option value="artistFirst">Artist first</option>
                  <option value="titleFirst">Title first</option>
                </select>
              </label>

              {renamePartsInvalid && (
                <p className="rename-warning" role="alert">
                  Choose at least one of artist, title, or album, or apply will
                  fail for rename.
                </p>
              )}

              <div className="rename-preview-box" aria-live="polite">
                <span className="rename-preview-label">Preview</span>
                <code className="mono rename-preview-value">
                  {s.rename.enabled
                    ? renameExample ?? "…"
                    : "—"}
                </code>
                <span className="rename-preview-note muted">
                  Example: Artist One, Track Title, Album Name, 2024
                </span>
              </div>
            </fieldset>
          </section>
        </div>
      </aside>
    </>
  );
}
