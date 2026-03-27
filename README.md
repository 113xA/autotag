# Library Autotag

Desktop app to clean filenames, auto-lookup tags/covers, review track proposals, and apply metadata/rename changes safely.

Built with:

- Tauri (Rust backend)
- React + TypeScript + Vite (frontend)

## Main Features

- Smart lookup for artist/title/album/year using multiple sources
- Cover proposals (up to 4 options) with source-aware ranking
- Manual MusicBrainz fallback button in review
- Filename cleaning rules (promo/source suffix stripping, dash split heuristics, feature normalization)
- Drag-friendly review flow (accept/skip) with candidate switching
- Rekordbox XML import/apply workflow
- Session persistence (pause/resume local review state)
- Spotify browser auth (PKCE) setup flow

## Filename-first lookup protocol

Lookup is driven by the **raw filename stem** plus **cleaned search strings** from scan (artist/title hints). The backend runs a fixed **phase order** so metadata is settled before cover-art harvesting, and the UI shows **what the lookup returned** for the selected candidate—not a blend with filename trimming.

### Phase 0 — Filename parse (scan)

- The folder scan reads each file’s embedded tags (if any) and builds **cleaned** strings: `searchArtist` / `searchTitle` (noise stripped for matching), and a human **display** string.
- These are sent to the backend as lookup hints; they are **not** what you accept when a lookup row exists (see “Review proposals” below).

### Phase 1 — Seed artist/title (optional)

- **Pass 0:** A guarded search on a **normalized** full stem can refine the seed used for downstream queries (only if it agrees with the filename parse or clearly wins on stem overlap—wrong tops cannot override the scoring baseline).
- **Artist guesses:** Deezer, iTunes (Apple catalog), Spotify, YouTube, etc. contribute possible artist strings; the app tries a few top guesses with query variants.

### Phase 2 — Parallel **metadata** fetch (no cover harvest)

- For each query variant, the app calls streaming/catalog APIs **in parallel** (Deezer, Spotify, iTunes track search, YouTube, Discogs when enabled).
- Each call returns **track rows** with artist, title, album, year when the provider has them.
- This step passes **`trusted_covers: true`** internally: it does **not** run the **cover-only** iTunes prefetch or push rows into the temporary **raw cover pool**. Candidate rows may still carry a cover URL that arrived in the **same** track response (that is metadata attached to the hit, not a separate cover pass).

### Phase 3 — Rank and dedupe

- Candidates are sanitized (e.g. compound “Artist - Title” strings), deduped, and scored against the **filename-derived baseline** (`searchArtist` / `searchTitle` from scan), not against an unguarded API seed.

### Phase 4 — Album / release year (MusicBrainz)

- For the **top two** ranked candidates that still lack album or year, the app runs a **MusicBrainz** lookup on that candidate’s artist/title and **merges** release title, date (year), album artist, recording/release MBIDs.
- This runs **before** the dedicated cover pipeline so album and year are as complete as possible before art is collected.

### Phase 5 — Optional verification

- If enabled in settings, a **MusicBrainz verification** pass can lock artist/title to an exact normalized pair and apply a trusted album/year from that match.

### Phase 6 — Cover search and options

- **`rebuild_cover_pool_after_metadata`** runs: existing art on ranked candidates, MusicBrainz/CAA, iTunes, Deezer, Discogs, etc., using the **final** artist/title (and verification when applicable).
- Up to four ranked **cover options** are attached per candidate for the review UI.

### Review proposals (what you accept)

- If the track has **at least one lookup candidate** and you have one **selected**, the proposed artist, title, album, album artist, track number, year, cover URL, and release MBID come **only from that candidate** (with a fallback to **embedded file tags** only when a field on the candidate is empty—never to filename trimming).
- If there are **no** candidates, the app falls back to embedded tags, then to the cleaned filename search strings.

This separation keeps **accept** aligned with the **search protocol** above instead of a mix of API + filename heuristics.

## App Workflow

1. Choose music folder
2. Files are scanned; cleaned strings feed lookup hints
3. Background lookup runs the protocol above
4. Review each track: cover, metadata fields, current vs proposed (proposed = selected candidate when present)
5. Accept / skip / edit manually
6. Apply tags + optional rename pattern

## Development

### Requirements

- Node.js 20+
- Rust stable toolchain
- Tauri prerequisites for your OS

### Commands

```bash
npm install
npm run desktop
```

Other useful commands:

```bash
npm run build
cd src-tauri && cargo check
```

## Project Structure

- `src/` frontend app (review UI, options, pages, API wrappers)
- `src-tauri/src/` Rust backend (scan, lookup, metadata apply, providers)
- `src/components/` review deck, options drawer, tool pages

## Notes

- The app is optimized for iterative manual review while lookups keep running in background.
- MusicBrainz is rate-limited; enriching the top candidates sequentially keeps behavior predictable.
- Cover and lookup logging can be verbose while debugging provider behavior (`verboseLogs` in matching settings).
