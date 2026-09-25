# Offline PGN Reader — Design & Architecture Record

Status: current · Updated: 2026-09-25 · Audience: solo maintainer

---

## 1. Scope definition

**In scope (v1)**

- Fully offline local web app: Node.js/TypeScript backend + browser UI served at `http://127.0.0.1:8642`.
- Standalone static mobile browser client: exactly one active copied PGN source, a browser Scan worker, and a versioned IndexedDB-backed Mobile Library. Its shell requires one initial online HTTPS load or installation before persisted reading works offline.
- Register local PGN files (by path, by discovery in watch dirs, or by upload-copy into `library/`).
- Streaming index of arbitrarily large PGN files: game boundaries, byte offsets, headers → SQLite.
- Lazy hydration of a single game by byte span into a full-fidelity move-tree document.
- Chessable-style reader: board, variation-aware notation with inline comments/NAGs, header panel,
  keyboard navigation, click-to-jump, variation stepping.
- Game list with Seven Tag Roster columns, paging, header search/filter.
- Change detection (fingerprint) and re-scan; per-game malformed-record tolerance.
- Raw-source PGN view/export per game (original bytes preserved via offsets while the source fingerprint matches).
- `[%cal]` arrow and `[%csl]` square-highlight graphics on the board.
- Structured logging, health endpoint, scan progress reporting, schema-versioned cache.

**Out of scope (v1)** — documented as upgrades: engine analysis, move training/spaced repetition,
PGN editing/writing, opening-tree aggregation across games, multi-user, and full-text comment
search.

## 2. Assumptions

- Single local user, single machine, trusted local files. The server binds 127.0.0.1 by default;
  host overrides are available for controlled local-network use.
- Files may be Chessable exports (observed in `samples/`): UTF-8 (sometimes BOM), CRLF possible,
  very long single-line movetext, `[FEN]` on every game, nonstandard Black move numbers (`1. c6`),
  suffix annotations (`!?`) and numeric NAGs, heavy RAV nesting, `*` results.
- On the desktop index path, "Large" means multi-hundred-MB files / millions of games; individual
  games stay small enough (< a few MB) to hydrate eagerly once selected. The mobile path accepts
  sources up to 50 MiB and GameDocument spans up to 8 MiB.
- Node.js 24.11.1 and npm 11.6.0 are the documented production setup (the package accepts
  Node.js `>=22.14.0 <27`). Chromium is used for browser verification.

## 3. Architecture decisions (ADR)

| Decision | Choice | Rationale / trade-off |
|---|---|---|
| Web framework | **Fastify** | Typed route seams via TypeBox, low-overhead local HTTP, multipart/static plugins, and one Node process for production. |
| Index store | **SQLite** (WAL), owned by `src/index.ts` | Zero-ops, single file in `data/`, fast enough for millions of rows, trivially backed up. `Index` owns registration, queries, status, tags, neighbors, transactional replacement, and reset; `src/database.ts` owns schema and connection lifecycle. The cache is schema-versioned and rebuildable from source PGNs at any time. |
| PGN parsing | **Two-layer: custom streaming scanner for indexing + chess.js for hydration** | chess.js supplies the production SAN/RAV/NAG/FEN implementation while the scanner remains movetext-free for large indexes. |
| Board state | **Server computes FEN per node during hydration** | UI never replays moves; every node carries its position. Costs response size (~100 bytes/node), saves all client-side chess logic and repeated recomputation. |
| Frontend | **Desktop: vanilla ES modules with no build step; mobile: compiled static modules** | One dev, offline, no framework runtime. The desktop board uses locally vendored CBurnett SVG pieces and inline graphics overlays; the mobile build vendors the same pieces and its chess modules. |
| Concurrency | **`LibraryService` owns Scan lifecycle; `src/scan-worker.ts` is a narrow worker adapter** | Keeps API responsive during multi-GB scans; progress is polled via `GET /api/files/{id}`. The Index replacement is transactional, so a failed replacement leaves the previous index intact, while remove/reset/shutdown are guarded by the same lifecycle owner. |
| Mobile Library | **`PersistentMobileLibrary` with an IndexedDB snapshot** | The mobile adapter projects the existing Game record vocabulary, receives browser-worker Scan events, bounds list pages to 50 records without limiting the total, and stages a replacement separately from the active source. One versioned IndexedDB record stores the source bytes, metadata, spans, ordered Tag pairs, warnings, and Index records; the active source changes only after the snapshot write succeeds. Sources over 50 MiB and GameDocument spans over 8 MiB are rejected, and failed or cancelled replacements leave the active snapshot intact. |
| Source fidelity | **`src/source.ts` owns fingerprint and span access** | Original bytes are never rewritten; Index stores offsets and ordered Tag pairs; source responses decode the indexed span as UTF-8 only after bounded, race-checked reads. Parser normalization affects the document model only, and changed or missing sources are refused rather than served through stale offsets. |

## 4. Parser strategy

**Layer A — boundary scanner (`src/scan.ts`), index time.**
The platform-neutral scanner consumes a `ByteSource` stream with manual byte offset accounting, so offsets are exact regardless of encoding. The filesystem-facing `src/scanner.ts` adapter keeps the existing path API, while `src/browser-source.ts` adapts a browser `File` or `Blob`. State
machine: `GAP → TAGS → MOVETEXT → (tag line seen) → boundary`. Crucially it tracks *brace-comment
state across lines* so a `[` at line start inside a multi-line `{comment}` is not misread as a new
game. Handles UTF-8 BOM, CRLF, `%` escape lines, `;` rest-of-line comments. Tag pairs are extracted
with a tag regex applied once per candidate line; movetext is otherwise only scanned for `{`/`}`/`;`.
Games that
never produce a valid tag section still become records (flagged `warning`) as long as movetext is
attributable; garbage between games is attached to the following boundary decision, never crashes
the scan.

**Layer B — source access and hydrator (`src/source.ts`, `src/browser-source.ts`, `src/hydration.ts`), read time.** The
Node source adapter checks the stored fingerprint; both source adapters validate the bounded span and read exactly
`offset_end - offset_start` bytes. The Node adapter checks the fingerprint again before returning. The
hydrator decodes UTF-8 (`errors="replace"`) and feeds the span to chess.js. The parser yields
the full recursive game tree: comments, starting comments, NAGs, variations, and
`[FEN]/[SetUp]` starting positions. The tree is converted iteratively
(explicit stack — nesting depth bounded, but no recursion-limit risk) into the document model
below.

**Layer C — reader projection (`src/projection.ts`), response time.** The projection owns the translation from stored Index rows and hydrated payloads to wire responses: source records, Game records, document identity, ordered Tag pairs, neighboring game ids, source text, and shared error envelopes. Library operations delegate these reads to the projection, while the HTTP server only adapts route parameters and response schemas.

**Known fidelity limits (documented not hidden):** multiple consecutive brace comments on one move
are merged into one comment string; `;` comments are folded into brace-style comments; escape lines
(`%`) are dropped from the parsed model. `[%cal]` arrows and `[%csl]` highlights are extracted
from root, move, and variation-start comments and removed from displayed comment text. Arrows are
straight lines, and a shape in a variation-start comment is displayed on that node's post-move
position. The indexed source span remains available through the raw-source endpoint while the
source fingerprint matches.

## 5. Indexing strategy

- `files` row per registered path with fingerprint = (size, mtime_ns, SHA-1 of the first up to 64
  KiB and, for larger files, the last 64 KiB).
  Unchanged ready files skip a scan; changed, pending, or failed files can be scanned, and force
  always starts a replacement.
- Scan streams the file once, emits `(idx_in_file, offset_start, offset_end, headers, warning)`
  per game; replacement rows are inserted in batches of 500 inside one transaction. Working
  memory is bounded by the current game's tag section plus that fixed insert batch, not the
  whole source.
- Progress stores `bytesDone`, `bytesTotal`, and `gamesFound` in an in-process registry and
  exposes those fields over the API.
- Roster tags get dedicated indexed columns (event/site/date/round/white/black/result + eco,
  opening); all ordered Tag pairs, including duplicates, are kept in `tag_json`. Dedicated
  columns project the last value for a repeated tag. Search is `LIKE` over white, black, event,
  site, opening, ECO, and date (FTS5 is a documented upgrade).
- Schema version lives in `meta`; on mismatch the DB is rebuilt (it is a cache).
- A process restart changes an interrupted `scanning` row to `pending`; a later scan retries from
  the source. A failed replacement transaction leaves the previous game rows available, while
  the file record is marked `error`.

## 6. Document model (`src/wire.ts`)

```
GameDocument
├─ gameId, fileId, fileName, idxInFile
├─ headers: [[name, value], ...]      # source order and duplicates preserved
├─ rootId: 0
├─ nodes: [GameNode, ...]             # nodes[0] is the root
├─ warnings: [str]                    # parser errors and scan warnings
├─ result: str                        # termination marker
├─ source: str                        # indexed source span, decoded as UTF-8
└─ neighbors: {prev, next}            # adjacent games in the same file

GameNode
├─ id, parentId: int | null            # flat preorder array and parent link
├─ san, uci: str | None               # None only on root
├─ ply, moveNumber, color: 'w'|'b'    # color is empty on root
├─ fen: str                           # position AFTER the move (root: starting position)
├─ nags: [int], glyphs: [str]         # numeric + rendered (!, ?!, ±, ...)
├─ comment: str                       # comment after the move
├─ startingComment: str               # comment before first move of a variation
├─ children: [int]                    # children[0] = main continuation, rest = sidelines
├─ arrows: [{from, to, color}]
└─ highlights: [{square, color}]
```

The wire document is a flat id-addressed array, but parent/child ids preserve an explicit tree.
Variation order and nesting are preserved exactly as parsed. Graphics are extracted from root,
move, and variation-start comments and removed from displayed comment text; a variation-start
shape is displayed on that node's post-move position.

## 7. API design

| Method & path | Purpose |
|---|---|
| `GET /api/health` | liveness, version, database status: `{status, version, db}` |
| `GET /api/files` | registered files plus scan status and progress |
| `POST /api/files` `{path}` | register a local `.pgn` path and start a background scan |
| `POST /api/files/upload` multipart `file` | copy an upload into `library/`, then register it |
| `GET /api/discover` | recursively find `.pgn` files in watch dirs, with registration state |
| `GET /api/files/{id}` | file detail including live progress and stale state |
| `POST /api/files/{id}/rescan?force=true\|false` | start a scan; HTTP default is forced, `false` permits unchanged-file skip |
| `DELETE /api/files/{id}` | remove indexed records; source file is untouched |
| `GET /api/files/{id}/games?q&offset&limit` | paged, filtered Game records; default limit 100, maximum 500 |
| `GET /api/games/{id}` | hydrated `GameDocument`, including adjacent-game ids |
| `GET /api/games/{id}/pgn` | indexed source span as decoded `text/plain` |
| `GET /api/games/{id}/tags` | ordered `[name, value]` Tag pairs, including duplicates |
| `POST /api/admin/reset` | drop and recreate the versioned index DB; source files are untouched |

The frontend is served at `/` and local assets at `/static/`. File and Game list fields use the
existing snake_case wire names (`scan_status`, `game_count`, `idx_in_file`); progress,
`GameDocument`, node, and rescan fields use camelCase (`bytesDone`, `gameId`, `startingComment`,
`parentId`, `scanStarted`). Errors use `{detail}` with 400 request validation, 404 not-found,
409 source/scan conflicts, and 422 invalid source type or invalid, oversized, or unreadable
hydration spans. Malformed PGN records are normally returned with warnings rather than a 422.
File records report `pending`, `scanning`, `ready`, or `error`; `stale` is derived from the source
fingerprint. Game records include the roster fields plus `eco`, `opening`, `has_fen`, `warning`,
and `byte_size`.

## 8. UI route/view map

Desktop uses these hash routes:

- `#/library` — file cards (status, game count, progress bar), discover/add/upload, Remove, and
  Reset controls.
- `#/file/{id}` — game table (Event/Site/Date/Round/White/Black/Result), search box, paging.
- `#/game/{id}` — reader: board (left) + notation pane (right) + header strip + raw-PGN drawer.
  Keyboard: `←`/`→` step within current line, `↑`/`↓` cycle sibling variations at a branch point,
  `Home`/`End`, click any move token. Comments render as prose blocks in the notation flow;
  sidelines as indented, bordered sub-blocks (collapsible at depth ≥ 3); NAG glyphs attach to
  their move token. Current node highlighted and kept scrolled into view. The board uses local
  CBurnett SVG pieces and renders `[%cal]`/`[%csl]` graphics.
- `/mobile/` — standalone static client: choose one `.pgn`, confirm replacements, restore or clear
  the persisted source, watch Scan status and progress, search roster metadata, and page through
  at most 50 Game records at once without a total-count cap.

## 9. Performance strategy

- Index: O(file size) single pass, no movetext parse, batched inserts — the only whole-file cost.
- Read: O(selected game) plus bounded fingerprint samples — read one span; list views are SQL
  paging, never hydration.
- Notation rendering: DOM is built in a detached tree; every 1,500 nodes yields to an animation
  frame so large documents do not monopolize the tab.
- Board updates are FEN lookups (no replay). Node map is a flat `id → node` array client-side.
- Honest trade-off: per-node FENs inflate the game JSON (~100 B/node). At Chessable-chapter sizes
  (≤ a few thousand nodes) this is ≤ ~1 MB and the win in simplicity/latency is decisive.

## 10. Testing strategy

Vitest (`tests-ts`) and Playwright are the test layers. Synthetic fixtures in `tests/fixtures/`
cover each PGN feature in isolation, while the TypeScript suite covers scanner, source-byte safety,
hydration, Index persistence, Scan lifecycle, projection, intake, Library actions, API/wire
contracts, configuration, CLI behavior, and the ten-fixture behavior-contract suite. The contract
suite uses `tests/fixtures/contract_manifest.json` and separate temporary SQLite files to verify
scan records, schema columns, indexed offsets, wire casing, ordered Tag pairs, flat GameDocument
nodes, source text, and route error envelopes. Playwright covers the desktop browser workflow;
`tests/mobile` serves only the compiled static client and verifies the worker-backed Scan/list,
versioned precache, install metadata, network-blocked reader restoration, and browser-persistence
slice without the desktop server.

## 11. Release strategy

Single folder, `npm install`; the desktop production path runs via `npm start` and owns the local
HTTP routes, filesystem-backed PGN sources, and SQLite cache. The mobile production path is the
static `mobile/` directory and must be served over HTTPS on a phone; the first online load or
installation supplies the cached shell. `src/index.ts` owns desktop persistence, `src/source.ts`
owns desktop source-byte protection, `LibraryService` owns desktop Scan coordination, and
`ReaderProjection` owns desktop response translation. TypeScript CLI subcommands are `serve`,
`index [--force] PATH...`, and `reset`. `npm run build` typechecks and builds the mobile
artifacts; `npm run build:mobile` rebuilds the mobile TypeScript output, vendored chess modules,
pieces, and service-worker precache. The desktop release gate is `npm run test:all`; the
mobile-specific gate is `npm run test:mobile`. `data/` is disposable cache — backup is optional,
rebuild is one command.
CHANGELOG.md tracks releases; schema version bump ⇒ automatic rebuild.

## Build history & resolved fallbacks

The delivered work followed this order:

1. Scaffold/config/DB (low risk, foundation)
2. **Scanner** (highest risk: correctness of offsets & boundaries on real Chessable exports)
3. **Parser/document model** (second risk: annotation fidelity)
4. Service + API
5. Frontend reader (third risk: variation rendering usability)
6. Tests green, browser verification, packaging, and TypeScript cutover

The custom scanner, server-positioned FENs, and vanilla-JS reader were retained; no alternate
frontend or client-side move replay was needed.
