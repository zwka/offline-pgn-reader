# Changelog

## Unreleased

- **Documentation check**: `npm run check:docs` checks the local Markdown links
  and npm scripts used in the repository, the generated mobile cache name, and
  recognized current Mobile Library schema references. It runs first in
  `npm run test:all`.
- **Single browser client**: the compiled mobile PWA is now the only browser
  application. Fastify serves `mobile/` at `/`, and the same client is verified
  at wide desktop and phone viewport sizes.
- **Mobile assets**: the CBurnett piece set now lives in `mobile/pieces/`, so the
  mobile build has no dependency on the retired browser UI tree.
- **Mobile Resume bookmarks**: each retained source now remembers the latest
  successfully opened Game record, persists that bookmark with the active-source
  selection, and offers Continue from the Game record's starting position.
- **Mobile release gate**: Playwright coverage now runs the mobile PWA through
  emulated Pixel 7 Chromium and iPhone 13 WebKit workflows, including Scan
  progress, multi-source IndexedDB persistence, offline reload/cache restore,
  import recovery, independent removal, search, touch reader controls, and the
  50 MiB / 8 MiB safety boundaries.
- **Mobile workflow protection**: the acceptance suite keeps multiple PGN sources
  available in the Mobile Library. The server and CLI retain their filesystem
  workflows without maintaining a second browser UI.
- **Mobile PWA**: the standalone `mobile/` build scans a selected PGN source in
  a browser worker, lazily opens GameDocuments from retained source bytes, and
  serves an installable, versioned offline shell after its initial HTTPS load
  or installation. The current generated service-worker cache is
  `offline-pgn-reader-mobile-v7`.
- **Mobile Library safety**: the versioned IndexedDB snapshot keeps retained
  source bytes, Index data, the active-source selection, and optional
  per-source Resume bookmarks together. Imports are scanned and promoted
  atomically; failed, cancelled, oversized, or storage-failing imports preserve
  the retained sources. Sources are limited to 50 MiB and GameDocuments to
  8 MiB, while the 50-record page size does not cap the total record count. The
  current snapshot schema is v3; v1 and v2 snapshots migrate on restore without
  inventing Resume bookmarks.
- **Runtime cleanup**: the former Python/FastAPI rollback runtime and the
  separate desktop browser UI were removed. Node.js is the sole server-side
  production runtime, and TypeScript owns the server implementation and
  verification suite.
- **Example PGNs**: the bundled course files were removed. Users select their
  own PGN sources.

## 1.1.0 — 2026-08-09

- **TypeScript production cutover**: `npm start` now launches the Fastify /
  TypeScript server and owns the browser routes and SQLite Index. During the
  cutover, the Python / FastAPI implementation was retained only for rollback
  and oracle validation.
- **Parity and recovery contracts**: cross-runtime fixtures cover scan offsets,
  SQLite schema, wire casing, source text, ordered duplicate Tag pairs,
  GameDocument nodes, graphics, and error envelopes. Interrupted scans recover
  as pending, failed replacement scans preserve the prior index, and CLI
  commands are `serve`, `index [--force] PATH...`, and `reset`.

- **Graphics annotations**: `[%cal]` arrows and `[%csl]` square highlights
  are extracted per node (including root/pre-game comments and variation
  starting comments), stripped from the displayed comment text, and drawn on
  the board with the Lichess brush palette. Author tints outrank the default
  last-move highlight; shapes reposition correctly when the board is flipped.
  Raw PGN source remains byte-exact.
- **CBurnett pieces**: replaced Unicode glyphs with the CBurnett SVG set
  (Lichess default), vendored locally in `frontend/pieces/` and still fully
  offline.
- **Fixed board square jitter**: grid rows are now fixed `1fr` tracks, so
  square size no longer depends on piece placement and never shifts between
  moves.
- **Deep module ownership and source safety**: `src/index.ts` owns Index
  persistence and transactional replacement, `src/source.ts` owns
  fingerprints and bounded race-checked source spans, `LibraryService` owns
  Scan lifecycle and protections, `src/hydration.ts` owns GameDocument
  recovery and annotation hydration, and `src/projection.ts` owns reader
  response translation and error envelopes.
- **Production TypeScript Scan benchmark**: the generated-source production
  path indexed 1,000,000 records in 12.064 s at 147.6 MiB peak RSS on the
  recorded arm64 macOS run; all Index rows, offsets, and sampled source spans
  verified successfully. See [the benchmark implementation](benchmarks/scan.ts).

## 1.0.0 — 2026-07-09

Initial release.

- Streaming PGN indexer with exact byte offsets, brace-comment-aware game
  boundary detection, BOM/CRLF tolerance, and per-game malformed-record
  warnings (SQLite Index schema v1, WAL).
- Per-game hydration via python-chess into an explicit move-tree document
  model: comments, starting comments, NAGs (+ glyph rendering), recursive
  variations, per-node FEN, FEN/SetUp starting positions.
- Fidelity hardening beyond stock python-chess: semicolon comments promoted
  to brace comments before parsing (previously silently dropped);
  unrecognized movetext tokens surfaced as parser warnings instead of
  vanishing.
- FastAPI backend (the rollback implementation): file registration/upload/discovery,
  background scans with progress, paged & filtered game lists, hydrated game
  documents, raw-source round-trip endpoint, health endpoint, index reset.
- Vanilla-JS frontend: library with scan progress, game table with search,
  Chessable-style reader (board, prose-flow annotations, collapsible
  sidelines, keyboard navigation, raw PGN drawer, header panel).
- CLI: `serve`, `index`, `reset`.
- 55-test pytest suite including regression fixtures over the real sample
  courses (185 + 351 games, exact counts and annotation spot checks).

Reference benchmarks (pre-cutover Python implementation, M-series laptop):
231 MB / 1M games indexed in ~20 s at ~38 MB peak RSS; game hydration by
stored offset ~2.5 ms at 1M-game index size.
