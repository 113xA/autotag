import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  libraryCatalogCount,
  libraryClearCatalog,
  libraryExportFile,
  libraryImportFile,
  libraryIndexFolder,
  libraryPortablePendingCount,
  previewRename,
  spotifyAuth,
  spotifyAuthBrowser,
} from "../api/tauri";
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

type PanelId =
  | "general"
  | "cleaning"
  | "matching"
  | "integrations"
  | "apply"
  | "rename"
  | "library"
  | "graphics"
  | "advanced";

const PANELS: {
  id: PanelId;
  label: string;
  blurb: string;
}[] = [
  {
    id: "general",
    label: "General",
    blurb: "Presets and what happens right after you pick a folder.",
  },
  {
    id: "cleaning",
    label: "Names & cleaning",
    blurb: "How filenames are normalized before search and display.",
  },
  {
    id: "matching",
    label: "MusicBrainz",
    blurb: "Core matching limits, tag filters, and fallback queries.",
  },
  {
    id: "integrations",
    label: "Other sources",
    blurb: "Optional hints from streaming and shops—Spotify needs setup below.",
  },
  {
    id: "apply",
    label: "Apply & tags",
    blurb: "What gets written to files when you confirm apply.",
  },
  {
    id: "rename",
    label: "File naming",
    blurb: "Rename pattern used only when you apply accepted tracks.",
  },
  {
    id: "library",
    label: "Music library",
    blurb: "Local catalog of tags and cleaning hints—export/import without filenames if you want.",
  },
  {
    id: "graphics",
    label: "Graphics",
    blurb: "Animations, density, and background effects.",
  },
  {
    id: "advanced",
    label: "Advanced",
    blurb: "Developer and troubleshooting options.",
  },
];

export function OptionsMenu({ settings, onChange, open, onClose }: Props) {
  const [panel, setPanel] = useState<PanelId>("general");
  const [renameExample, setRenameExample] = useState<string | null>(null);
  const [spotifyStatus, setSpotifyStatus] = useState<string | null>(null);
  const [libCatalogCount, setLibCatalogCount] = useState<number | null>(null);
  const [libPortableCount, setLibPortableCount] = useState<number | null>(null);
  const [libMsg, setLibMsg] = useState<string | null>(null);
  const [libBusy, setLibBusy] = useState(false);
  const [exportIncludePaths, setExportIncludePaths] = useState(false);
  const [exportIncludeFileName, setExportIncludeFileName] = useState(false);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<Element | null>(null);
  const wasOpenRef = useRef(false);

  const refreshLibCatalog = useCallback(async () => {
    try {
      const [c, p] = await Promise.all([
        libraryCatalogCount(),
        libraryPortablePendingCount(),
      ]);
      setLibCatalogCount(c);
      setLibPortableCount(p);
    } catch {
      setLibCatalogCount(null);
      setLibPortableCount(null);
    }
  }, []);

  useEffect(() => {
    if (!open || panel !== "library") return;
    setLibMsg(null);
    void refreshLibCatalog();
  }, [open, panel, refreshLibCatalog]);

  const handleLibraryIndex = async () => {
    if (libBusy) return;
    const dir = await openDialog({ directory: true, multiple: false });
    if (!dir || Array.isArray(dir)) return;
    setLibBusy(true);
    setLibMsg(null);
    try {
      const r = await libraryIndexFolder(dir, settings.cleaning);
      setLibMsg(`Indexed ${r.indexed} files into the local catalog.`);
      await refreshLibCatalog();
    } catch (e) {
      setLibMsg(String(e));
    } finally {
      setLibBusy(false);
    }
  };

  const handleLibraryExport = async () => {
    if (libBusy) return;
    const path = await save({
      filters: [{ name: "JSON", extensions: ["json"] }],
      defaultPath: "library-catalog.json",
    });
    if (path == null) return;
    setLibBusy(true);
    setLibMsg(null);
    try {
      await libraryExportFile(path, exportIncludePaths, exportIncludeFileName);
      setLibMsg("Catalog exported.");
    } catch (e) {
      setLibMsg(String(e));
    } finally {
      setLibBusy(false);
    }
  };

  const handleLibraryImport = async () => {
    if (libBusy) return;
    const f = await openDialog({
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!f || Array.isArray(f)) return;
    setLibBusy(true);
    setLibMsg(null);
    try {
      const r = await libraryImportFile(f);
      setLibMsg(
        `Imported ${r.rowsWithPath} row(s) with path; ${r.portableRows} metadata-only (merged when you index matching tracks).`,
      );
      await refreshLibCatalog();
    } catch (e) {
      setLibMsg(String(e));
    } finally {
      setLibBusy(false);
    }
  };

  const handleLibraryClear = async () => {
    if (libBusy) return;
    if (
      !window.confirm(
        "Clear the entire local music catalog (including pending portable imports)?",
      )
    ) {
      return;
    }
    setLibBusy(true);
    setLibMsg(null);
    try {
      await libraryClearCatalog();
      setLibMsg("Catalog cleared.");
      await refreshLibCatalog();
    } catch (e) {
      setLibMsg(String(e));
    } finally {
      setLibBusy(false);
    }
  };

  useEffect(() => {
    if (open) setPanel("general");
  }, [open]);

  useEffect(() => {
    if (!open) return;
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
      if (wasOpenRef.current) {
        if (previousFocusRef.current instanceof HTMLElement) {
          previousFocusRef.current.focus();
        } else {
          const settingsBtn = document.querySelector(".settings-btn");
          if (settingsBtn instanceof HTMLElement) settingsBtn.focus();
        }
      }
      wasOpenRef.current = false;
      return;
    }
    if (!wasOpenRef.current) {
      previousFocusRef.current = document.activeElement;
      wasOpenRef.current = true;
    }
    modalRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab") {
        const root = modalRef.current;
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
  const active = PANELS.find((p) => p.id === panel)!;

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
      <div
        className="options-modal"
        aria-labelledby="options-modal-heading"
        aria-modal="true"
        tabIndex={-1}
        ref={modalRef}
        role="dialog"
      >
        <div className="options-modal-top">
          <div className="options-modal-top-text">
            <h2 id="options-modal-heading" className="options-modal-title">
              Settings
            </h2>
            <p className="options-modal-sub">{active.label}</p>
          </div>
          <button type="button" className="btn btn-ghost icon-close" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="options-modal-grid">
          <nav className="options-nav" aria-label="Settings sections">
            {PANELS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`options-nav-item ${panel === p.id ? "active" : ""}`}
                aria-current={panel === p.id ? "page" : undefined}
                onClick={() => setPanel(p.id)}
              >
                <span className="options-nav-item-label">{p.label}</span>
                <span className="options-nav-item-desc">{p.blurb}</span>
              </button>
            ))}
          </nav>

          <div className="options-panel">
            <p className="options-panel-intro">{active.blurb}</p>
            <div className="options-panel-scroll">
              <div key={panel} className="options-panel-body">
              {panel === "general" && (
                <>
                  <section className="opt-section opt-card">
                    <h3 className="opt-heading">EDM presets</h3>
                    <p className="opt-lead">
                      One tap sets MusicBrainz tag bias and a default genre for apply. You can
                      override everything on other pages.
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

                  <section className="opt-section opt-card">
                    <h3 className="opt-heading">Import workflow</h3>
                    <p className="opt-lead">
                      After you choose a folder, the app can look up every track on MusicBrainz
                      automatically, or wait until you use the toolbar.
                    </p>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={s.autoLookupOnImport}
                        onChange={(e) =>
                          onChange({ ...s, autoLookupOnImport: e.target.checked })
                        }
                      />
                      Run MusicBrainz lookup for all files right after scan
                    </label>
                    <p className="opt-hint opt-hint-tight">
                      File rename rules are under <strong>File naming</strong>.
                    </p>
                  </section>
                </>
              )}

              {panel === "cleaning" && (
                <section className="opt-section opt-card">
                  <h3 className="opt-heading">Filename cleaning</h3>
                  <p className="opt-lead">
                    These rules run on the filename (and related text) to build a clean search
                    query and a readable display name. They do not rename files on disk until you
                    apply with rename enabled.
                  </p>
                  <div className="opt-check-group">
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
                      Strip promo site names in (parentheses)
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
                      Turn underscores into spaces
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
                      Collapse repeated spaces
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
                      Normalize “ft.” / “feat.” / “vs.” style wording
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
                      Strip common DJ-mix words from titles (for search)
                    </label>
                  </div>
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
                    Apply noise stripping for search only (keep longer text on screen)
                  </label>
                  <label className="field">
                    <span>Split artist and title at</span>
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
              )}

              {panel === "matching" && (
                <section className="opt-section opt-card">
                  <h3 className="opt-heading">MusicBrainz matching</h3>
                  <p className="opt-lead">
                    Controls how many releases are fetched and how queries are widened when the
                    first pass finds nothing.
                  </p>
                  <label className="field">
                    <span>Maximum candidates per track</span>
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
                    <span>Tag bias (optional Lucene fragment)</span>
                    <p className="opt-field-desc">
                      Narrows MusicBrainz to genres or styles you care about, e.g. techno or
                      electronic.
                    </p>
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
                  <div className="opt-check-group">
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
                      If empty, retry as recording-only query
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
                      If still empty, strip ( ) / [ ] from title and retry
                    </label>
                  </div>
                </section>
              )}

              {panel === "integrations" && (
                <section className="opt-section opt-card">
                  <h3 className="opt-heading">Extra hint sources</h3>
                  <p className="opt-lead">
                    These services can suggest artist/title or cover URLs. They are optional;
                    MusicBrainz remains the main catalog. Enable only what you are comfortable
                    calling from this app.
                  </p>
                  <div className="opt-check-group">
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
                      Apple iTunes Search (filename stem as hint)
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
                      Deezer (public API, no login)
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
                      Spotify (needs app + login below)
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
                      Amazon product search (cover hints)
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={s.matching.useDiscogs}
                        onChange={(e) =>
                          onChange({
                            ...s,
                            matching: {
                              ...s.matching,
                              useDiscogs: e.target.checked,
                            },
                          })
                        }
                      />
                      Discogs (track + cover verification)
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
                      YouTube (video / topic metadata)
                    </label>
                  </div>

                  <h4 className="opt-subheading">Post-lookup verification</h4>
                  <p className="opt-hint">
                    Run these checks only after filename-based matching has produced candidate
                    suggestions.
                  </p>
                  <div className="opt-check-group">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={s.matching.verifyMusicbrainzAfterFilename}
                        onChange={(e) =>
                          onChange({
                            ...s,
                            matching: {
                              ...s.matching,
                              verifyMusicbrainzAfterFilename: e.target.checked,
                            },
                          })
                        }
                      />
                      Verify top candidate with MusicBrainz after filename lookup
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={s.matching.verifyFingerprintAfterFilename}
                        onChange={(e) =>
                          onChange({
                            ...s,
                            matching: {
                              ...s.matching,
                              verifyFingerprintAfterFilename: e.target.checked,
                            },
                          })
                        }
                      />
                      Enable fingerprint-service verification stage (placeholder)
                    </label>
                  </div>

                  {s.matching.useDiscogs && (
                    <div className="opt-card opt-subsection">
                      <h4 className="opt-subheading">Discogs token</h4>
                      <p className="opt-hint">
                        Needed to access Discogs release images and validate track+cover matches.
                      </p>
                      <label className="field block">
                        <span>Discogs user token</span>
                        <input
                          type="password"
                          value={s.matching.discogsToken ?? ""}
                          onChange={(e) =>
                            onChange({
                              ...s,
                              matching: {
                                ...s.matching,
                                discogsToken: e.target.value.trim() || null,
                              },
                            })
                          }
                          placeholder="Paste Discogs token"
                        />
                      </label>
                    </div>
                  )}

                  <label className="field">
                    <span>Parallel lookups</span>
                    <p className="opt-field-desc">
                      Number of tracks looked up simultaneously. Higher values are faster but use
                      more network bandwidth. Recommended: 4-12 for most systems.
                    </p>
                    <input
                      type="range"
                      min={1}
                      max={16}
                      step={1}
                      value={s.matching.concurrency}
                      onChange={(e) =>
                        onChange({
                          ...s,
                          matching: {
                            ...s.matching,
                            concurrency: Number(e.target.value),
                          },
                        })
                      }
                    />
                    <span className="range-value">{s.matching.concurrency} threads</span>
                  </label>

                  <h4 className="opt-subheading">Spotify app</h4>
                  <p className="opt-hint">
                    Create an app in the Spotify Developer Dashboard, add the redirect URI below,
                    then connect. Browser login is easiest if you prefer not to store a client
                    secret.
                  </p>
                  <label className="field block">
                    <span>Client ID</span>
                    <input
                      value={s.spotifyClientId ?? ""}
                      onChange={(e) =>
                        onChange({
                          ...s,
                          spotifyClientId: e.target.value.trim() || null,
                        })
                      }
                      placeholder="From developer.spotify.com"
                    />
                  </label>
                  <label className="field block">
                    <span>Client secret (optional)</span>
                    <input
                      type="password"
                      value={s.spotifyClientSecret ?? ""}
                      onChange={(e) =>
                        onChange({
                          ...s,
                          spotifyClientSecret: e.target.value.trim() || null,
                        })
                      }
                      placeholder="Only for “client secret” connect"
                    />
                  </label>
                  <ol className="opt-steps">
                    <li>
                      In the Spotify dashboard, add redirect URI:{" "}
                      <code className="mono">{SPOTIFY_REDIRECT_URI}</code>
                    </li>
                    <li>Paste your Client ID (and secret if you use that flow).</li>
                    <li>Use <strong>Connect Spotify (browser)</strong> or the secret flow.</li>
                    <li>Turn on <strong>Spotify</strong> in the list above.</li>
                  </ol>
                  <div className="row opt-btn-row">
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
                            out.ok
                              ? `Spotify connected (${out.expiresIn}s token)`
                              : "Spotify auth failed",
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
                    <p className="opt-hint">Add a Client ID to enable browser connect.</p>
                  )}
                  {spotifyStatus && <p className="opt-hint">{spotifyStatus}</p>}
                </section>
              )}

              {panel === "apply" && (
                <section className="opt-section opt-card">
                  <h3 className="opt-heading">Metadata on apply</h3>
                  <p className="opt-lead">
                    When you finish review and choose apply, these options control tags and
                    embedded images. Renaming files is configured separately under{" "}
                    <strong>File naming</strong>.
                  </p>
                  <div className="opt-check-group">
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
                      Write standard tags (artist, title, album, …)
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
                      Embed front cover image when one is chosen
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
                      If MusicBrainz has no art, try Apple’s public search (artist + title)
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
                      When embed cover is on but nothing is found, embed a placeholder image
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={s.autoApplyOnComplete}
                        onChange={(e) =>
                          onChange({ ...s, autoApplyOnComplete: e.target.checked })
                        }
                      />
                      Auto-apply when all tracks have been reviewed (skips confirmation)
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={s.autoAcceptHighConfidence}
                        onChange={(e) =>
                          onChange({ ...s, autoAcceptHighConfidence: e.target.checked })
                        }
                      />
                      Auto-accept high-confidence matches (skip review for near-perfect matches)
                    </label>
                    <label className="field">
                      <span>Auto-accept confidence threshold</span>
                      <p className="opt-field-desc">
                        Tracks at or above this confidence score are auto-accepted in the
                        background when auto-accept mode is enabled.
                      </p>
                      <input
                        type="range"
                        min={70}
                        max={100}
                        step={1}
                        value={s.autoAcceptConfidenceThreshold}
                        onChange={(e) =>
                          onChange({
                            ...s,
                            autoAcceptConfidenceThreshold: Number(e.target.value),
                          })
                        }
                        disabled={!s.autoAcceptHighConfidence}
                      />
                      <span className="range-value">{s.autoAcceptConfidenceThreshold}%</span>
                    </label>
                  </div>
                  <label className="field">
                    <span>Genre</span>
                    <p className="opt-field-desc">
                      Quick picks set the field; you can type any custom value below.
                    </p>
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
                      placeholder="Custom genre (overrides quick pick when different)"
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
              )}

              {panel === "rename" && (
                <section className="opt-section opt-card">
                  <h3 className="opt-heading">File naming on apply</h3>
                  <p className="opt-lead">
                    Only runs when you accept tracks and confirm apply. The preview uses example
                    metadata so you can see the pattern without touching your library.
                  </p>
                  <p className="opt-hint">
                    When year is enabled, it is appended like <span className="mono">(2024)</span>.
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

                  <fieldset className="rename-fieldset" disabled={!s.rename.enabled}>
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
                        <option value="dashSpaced">Space - space ( - )</option>
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
                        Pick at least one of artist, title, or album, or apply will fail when
                        rename is on.
                      </p>
                    )}

                    <div className="rename-preview-box" aria-live="polite">
                      <span className="rename-preview-label">Preview</span>
                      <code className="mono rename-preview-value">
                        {s.rename.enabled ? renameExample ?? "…" : "—"}
                      </code>
                      <span className="rename-preview-note muted">
                        Example: Artist One, Track Title, Album Name, 2024
                      </span>
                    </div>
                  </fieldset>
                </section>
              )}

              {panel === "library" && (
                <section className="opt-section opt-card">
                  <h3 className="opt-heading">Local music catalog</h3>
                  <p className="opt-lead">
                    SQLite database in app data: embedded tags, cleaned search strings, and a stable
                    fingerprint per track. Use it as a full local library index and sync metadata
                    between machines.
                  </p>
                  <p className="muted">
                    Indexed tracks: <strong>{libCatalogCount ?? "—"}</strong>
                    {" · "}
                    Portable rows waiting for merge: <strong>{libPortableCount ?? "—"}</strong>
                  </p>
                  <div
                    className="row"
                    style={{ flexWrap: "wrap", gap: "0.5rem", marginTop: "0.75rem" }}
                  >
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={libBusy}
                      onClick={handleLibraryIndex}
                    >
                      Index folder into catalog
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={libBusy}
                      onClick={() => void refreshLibCatalog()}
                    >
                      Refresh counts
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={libBusy}
                      onClick={handleLibraryClear}
                    >
                      Clear catalog
                    </button>
                  </div>

                  <h4 className="opt-heading" style={{ marginTop: "1.25rem" }}>
                    Export JSON
                  </h4>
                  <p className="opt-lead">
                    Uncheck both options for a portable file with metadata only (no path, no file
                    name). Re-import that file, then index the same music folder here to merge rows
                    by fingerprint.
                  </p>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={exportIncludePaths}
                      onChange={(e) => setExportIncludePaths(e.target.checked)}
                    />
                    Include file paths (same-machine backup / restore)
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={exportIncludeFileName}
                      onChange={(e) => setExportIncludeFileName(e.target.checked)}
                    />
                    Include file name field
                  </label>
                  <div className="row" style={{ marginTop: "0.5rem" }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={libBusy}
                      onClick={handleLibraryExport}
                    >
                      Export catalog…
                    </button>
                  </div>

                  <h4 className="opt-heading" style={{ marginTop: "1.25rem" }}>
                    Import JSON
                  </h4>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={libBusy}
                    onClick={handleLibraryImport}
                  >
                    Import catalog…
                  </button>
                  {libMsg && (
                    <p className="muted" style={{ marginTop: "0.75rem" }} aria-live="polite">
                      {libMsg}
                    </p>
                  )}
                </section>
              )}

              {panel === "graphics" && (
                <section className="opt-section opt-card">
                  <h3 className="opt-heading">Graphics</h3>
                  <p className="opt-lead">
                    Control motion effects and UI density. This only affects the look of
                    the interface (no changes to your music metadata).
                  </p>

                  <label className="check">
                    <input
                      type="checkbox"
                      checked={s.graphics.animationsEnabled}
                      onChange={(e) =>
                        onChange({
                          ...s,
                          graphics: {
                            ...s.graphics,
                            animationsEnabled: e.target.checked,
                          },
                        })
                      }
                    />
                    Enable animations
                  </label>

                  <label className="field">
                    <span>Animation intensity</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={s.graphics.animationIntensity}
                      onChange={(e) =>
                        onChange({
                          ...s,
                          graphics: {
                            ...s.graphics,
                            animationIntensity: Number(e.target.value),
                          },
                        })
                      }
                      disabled={!s.graphics.animationsEnabled}
                    />
                    <span className="range-value">
                      {s.graphics.animationIntensity}%
                    </span>
                  </label>

                  <label className="check">
                    <input
                      type="checkbox"
                      checked={s.graphics.backgroundEffects}
                      onChange={(e) =>
                        onChange({
                          ...s,
                          graphics: {
                            ...s.graphics,
                            backgroundEffects: e.target.checked,
                          },
                        })
                      }
                    />
                    Background effects
                  </label>

                  <label className="field">
                    <span>UI density</span>
                    <select
                      value={s.graphics.uiDensity}
                      onChange={(e) =>
                        onChange({
                          ...s,
                          graphics: {
                            ...s.graphics,
                            uiDensity: e.target.value as "comfortable" | "compact",
                          },
                        })
                      }
                    >
                      <option value="comfortable">Comfortable</option>
                      <option value="compact">Compact</option>
                    </select>
                  </label>
                </section>
              )}

              {panel === "advanced" && (
                <section className="opt-section opt-card opt-section-danger">
                  <h3 className="opt-heading">Developer</h3>
                  <p className="opt-lead">
                    Verbose logging prints detailed messages in the browser console and the app
                    terminal. Use only when debugging matching or cover lookup.
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
                    Verbose logs (frontend + Rust backend)
                  </label>
                </section>
              )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
