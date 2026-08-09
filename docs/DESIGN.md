# Offline PGN Reader — Design & Architecture Record

Status: v1.1.0 · Date: 2026-08-08 · Audience: solo maintainer

---

## 1. Scope definition

**In scope (v1)**

- Fully offline local web app: Node.js/TypeScript backend + browser UI served at `http://127.0.0.1:8642`.
- Python remains in the repository only as the rollback runtime and compatibility oracle.
- Register local PGN files (by path, by discovery in watch dirs, or by upload-copy into `library/`).
- Streaming index of arbitrarily large PGN files: game boundaries, byte offsets, headers → SQLite.
- Lazy hydration of a single game by byte span into a full-fidelity move-tree document.
- Chessable-style reader: board, variation-aware notation with inline comments/NAGs, header panel,
  keyboard navigation, click-to-jump, variation stepping.
- Game list with Seven Tag Roster columns, paging, header search/filter.
- Change detection (fingerprint) and re-scan; per-game malformed-record tolerance.
- Raw-source PGN view/export per game (true round-trip: original bytes preserved via offsets).
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
- "Large" means multi-hundred-MB files / millions of games for the *index* path; individual games
  stay small enough (< a few MB) to hydrate eagerly once selected.
- Node.js 24.11.1 and npm 11.6.0 are the documented production setup (the package accepts
  Node.js `>=22.14.0 <27`); Python 3.11+ is available for rollback and oracle checks. Chromium is
  used for browser verification.

## 3. Architecture decisions (ADR)

| Decision | Choice | Rationale / trade-off |
|---|---|---|
| Web framework | **Fastify** | Typed route seams via TypeBox, low-overhead local HTTP, multipart/static plugins, and one Node process for production. FastAPI remains the rollback runtime and oracle. |
| Index store | **SQLite** (WAL) | Zero-ops, single file in `data/`, fast enough for millions of rows, trivially backed up. Schema-versioned; rebuildable from source PGNs at any time (cache, not source of truth). |
| PGN parsing | **Two-layer: custom streaming scanner for indexing + chess.js for hydration** | chess.js supplies the production SAN/RAV/NAG/FEN implementation while the scanner remains movetext-free for large indexes. The Python `python-chess` implementation runs against the same fixtures as the compatibility oracle. |
| Board state | **Server computes FEN per node during hydration** | UI never replays moves; every node carries its position. Costs response size (~100 bytes/node), saves all client-side chess logic and repeated recomputation. |
| Frontend | **Vanilla ES modules, no build step** | One dev, offline, no toolchain rot. ~1.5k lines of JS is well within no-framework territory. The board uses locally vendored CBurnett SVG pieces and inline graphics overlays. |
| Concurrency | Scan runs in a worker thread; SQLite connection-per-operation with WAL | Keeps API responsive during multi-GB scans; progress is polled via `GET /api/files/{id}`. A replacement scan is transactional, so a failed replacement leaves the previous index intact. |
| Source fidelity | Original bytes are never rewritten; index stores offsets and ordered Tag pairs; source responses decode the indexed span as UTF-8 | Parser normalization affects the document model only. The source file remains the byte-level source of truth and is always read from the stored span. |

## 4. Parser strategy

**Layer A — boundary scanner (`src/scanner.ts`, with the Python oracle counterpart), index time.**
Binary chunk iteration with manual byte offset accounting, so offsets are exact regardless of encoding. State
machine: `GAP → TAGS → MOVETEXT → (tag line seen) → boundary`. Crucially it tracks *brace-comment
state across lines* so a `[` at line start inside a multi-line `{comment}` is not misread as a new
game. Handles UTF-8 BOM, CRLF, `%` escape lines, `;` rest-of-line comments. Tag pairs are extracted
with one compiled regex per line; movetext is otherwise only scanned for `{`/`}`/`;`. Games that
never produce a valid tag section still become records (flagged `warning`) as long as movetext is
attributable; garbage between games is attached to the following boundary decision, never crashes
the scan.

**Layer B — hydrator (`src/hydration.ts`), read time.** Seek to `offset_start`, read
`offset_end - offset_start` bytes, decode UTF-8 (`errors="replace"`), and feed the span to
chess.js. The parser yields the full recursive game tree: comments, starting comments, NAGs,
variations, and `[FEN]/[SetUp]` starting positions. The tree is converted iteratively
(explicit stack — nesting depth bounded, but no recursion-limit risk) into the document model
below. `pgnreader/parser.py` provides the same operation through python-chess for rollback and
parity checks.

**Layer C — reader projection (`src/projection.ts`), response time.** The projection owns the translation from stored Index rows and hydrated payloads to wire responses: source records, Game records, document identity, ordered Tag pairs, neighboring game ids, source text, and shared error envelopes. Library operations delegate these reads to the projection, while the HTTP server only adapts route parameters and response schemas.

**Known fidelity limits (documented not hidden):** multiple consecutive brace comments on one move
are merged into one comment string; `;` comments are folded into brace-style comments; escape lines
(`%`) are dropped from the parsed model. `[%cal]` arrows and `[%csl]` highlights are extracted
from root, move, and variation-start comments and removed from displayed comment text. Arrows are
straight lines, and a shape in a variation-start comment is displayed on that node's post-move
position. The source file remains available through the raw-source endpoint.

## 5. Indexing strategy

- `files` row per registered path with fingerprint = (size, mtime_ns, SHA-1 of the first up to 64
  KiB and, for larger files, the last 64 KiB).
  Re-scan only when fingerprint changes (or forced).
- Scan streams the file once, emits `(idx_in_file, offset_start, offset_end, headers, warning)`
  per game; replacement rows are inserted in batches of 500 inside one transaction. Memory is
  O(one game's tag section).
- Progress = bytes consumed / file size, stored in an in-process registry, exposed over the API.
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
409 source/scan conflicts, and 422 invalid source type or PGN.
File records report `pending`, `scanning`, `ready`, or `error`; `stale` is derived from the source
fingerprint. Game records include the roster fields plus `eco`, `opening`, `has_fen`, `warning`,
and `byte_size`.

## 8. UI route/view map (hash-routed SPA)

- `#/library` — file cards (status, game count, progress bar), discover/add/upload, Remove, and
  Reset controls.
- `#/file/{id}` — game table (Event/Site/Date/Round/White/Black/Result), search box, paging.
- `#/game/{id}` — reader: board (left) + notation pane (right) + header strip + raw-PGN drawer.
  Keyboard: `←`/`→` step within current line, `↑`/`↓` cycle sibling variations at a branch point,
  `Home`/`End`, click any move token. Comments render as prose blocks in the notation flow;
  sidelines as indented, bordered sub-blocks (collapsible at depth ≥ 3); NAG glyphs attach to
  their move token. Current node highlighted and kept scrolled into view. The board uses local
  CBurnett SVG pieces and renders `[%cal]`/`[%csl]` graphics.

## 9. Performance strategy

- Index: O(file size) single pass, no movetext parse, batched inserts — the only whole-file cost.
- Read: O(selected game) — seek + read one span; list views are SQL paging, never hydration.
- Notation rendering: DOM is built in a detached tree; every 1,500 nodes yields to an animation
  frame so large documents do not monopolize the tab.
- Board updates are FEN lookups (no replay). Node map is a flat `id → node` array client-side.
- Honest trade-off: per-node FENs inflate the game JSON (~100 B/node). At Chessable-chapter sizes
  (≤ a few thousand nodes) this is ≤ ~1 MB and the win in simplicity/latency is decisive.

## 10. Testing strategy

Vitest (`tests-ts`), pytest (`tests`), and a cross-runtime parity test are the test layers.
Synthetic fixtures in `tests/fixtures/` cover each PGN feature in isolation; the Python sample
regression tests use the two tracked course files when present (185 and 351 games). TypeScript
tests cover scanner, hydration, intake, Library actions, API/wire contracts, configuration, and
CLI behavior; Python tests retain the rollback implementation checks. Playwright covers the
browser workflow. The parity test runs the Node and Python HTTP implementations against the same
ten-fixture manifest (`tests/fixtures/parity_manifest.json`) and separate temporary SQLite files,
then compares scan records, schema columns, indexed offsets, wire casing, ordered Tag pairs, flat
GameDocument nodes, source text, and route error envelopes.

## 11. Release strategy

Single folder, `npm install`; production runs via `npm start` and owns the local HTTP routes and
SQLite cache. TypeScript CLI subcommands are `serve`, `index [--force] PATH...`, and `reset`.
The Python environment is optional and is retained only for `python -m pgnreader serve` rollback
and oracle validation; use a separate data directory and port for that process. The acceptance
gate is `npm run test:all`. `data/` is disposable cache — backup is optional, rebuild is one
command.
CHANGELOG.md tracks releases; schema version bump ⇒ automatic rebuild.

## Build history & resolved fallbacks

The delivered work followed this order:

1. Scaffold/config/DB (low risk, foundation)
2. **Scanner** (highest risk: correctness of offsets & boundaries on real Chessable exports)
3. **Parser/document model** (second risk: annotation fidelity)
4. Service + API
5. Frontend reader (third risk: variation rendering usability)
6. Tests green, browser verification, packaging, and TypeScript cutover

The custom scanner, server-positioned FENs, and vanilla-JS reader were retained. Python
`python-chess` remains the rollback/oracle implementation, not the production parser; no alternate
frontend or client-side move replay was needed.
