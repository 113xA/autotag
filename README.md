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

## App Workflow

1. Choose music folder
2. Files are scanned and cleaned for search input
3. Background lookup starts automatically
4. Review each track:
   - cover
   - title (current vs proposed)
   - metadata fields
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
- Cover and lookup logging can be verbose while debugging provider behavior.
