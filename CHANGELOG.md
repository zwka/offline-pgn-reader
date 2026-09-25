# Changelog

## Unreleased

- **Mobile release gate**: Playwright coverage now runs the mobile PWA through
  emulated Pixel 7 Chromium and iPhone 13 WebKit workflows, including Scan
  progress, IndexedDB persistence, offline reload/cache restore, replacement
  recovery, clear, search, touch reader controls, and the 50 MiB / 8 MiB safety
  boundaries.
- **Desktop workflow protection**: the acceptance suite explicitly keeps
  multiple PGN sources available in the desktop Library. The mobile PWA remains
  the phone target and its one-source rule does not apply to desktop.

## 1.1.0 — 2026-08-09

- **TypeScript production cutover**: `npm start` now launches the Fastify /
  TypeScript server and owns the browser routes and SQLite cache. The Python /
  FastAPI implementation remains available only for rollback and oracle
  validation.
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
  (Lichess default), vendored locally in `frontend/pieces/` — still fully
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
  verified successfully. See [the benchmark report](docs/benchmarks/typescript-scan.md).

## 1.0.0 — 2026-07-09

Initial release.

- Streaming PGN indexer with exact byte offsets, brace-comment-aware game
  boundary detection, BOM/CRLF tolerance, and per-game malformed-record
  warnings (schema v1 SQLite cache, WAL).
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
