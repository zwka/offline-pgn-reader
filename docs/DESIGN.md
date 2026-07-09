# Offline PGN Reader — Design & Architecture Record

Status: v1.0 · Date: 2026-07-09 · Audience: solo maintainer

---

## 1. Scope definition

**In scope (v1)**

- Fully offline local web app: Python backend + browser UI served at `http://127.0.0.1:8642`.
- Register local PGN files (by path, by discovery in watch dirs, or by upload-copy into `library/`).
- Streaming index of arbitrarily large PGN files: game boundaries, byte offsets, headers → SQLite.
- Lazy hydration of a single game by byte span into a full-fidelity move-tree document.
- Chessable-style reader: board, variation-aware notation with inline comments/NAGs, header panel,
  keyboard navigation, click-to-jump, variation stepping.
- Game list with Seven Tag Roster columns, paging, header search/filter.
- Change detection (fingerprint) and re-scan; per-game malformed-record tolerance.
- Raw-source PGN view/export per game (true round-trip: original bytes preserved via offsets).
- Structured logging, health endpoint, scan progress reporting, schema-versioned cache.

**Out of scope (v1)** — documented as upgrades: engine analysis, move training/spaced repetition,
PGN editing/writing, opening-tree aggregation across games, multi-user, arrows/shape rendering
from `%cal/%csl`, full-text comment search.

## 2. Assumptions

- Single local user, single machine, trusted local files. Server binds 127.0.0.1 only.
- Files may be Chessable exports (observed in `samples/`): UTF-8 (sometimes BOM), CRLF possible,
  very long single-line movetext, `[FEN]` on every game, nonstandard Black move numbers (`1. c6`),
  suffix annotations (`!?`) and numeric NAGs, heavy RAV nesting, `*` results.
- "Large" means multi-hundred-MB files / millions of games for the *index* path; individual games
  stay small enough (< a few MB) to hydrate eagerly once selected.
- Python 3.11+ available (3.14 on the target machine); Brave (Chromium) is the target browser.

## 3. Architecture decisions (ADR)

| Decision | Choice | Rationale / trade-off |
|---|---|---|
| Web framework | **FastAPI** | Typed request/response models via Pydantic, async-capable, auto OpenAPI docs for a solo dev, uvicorn is a single lightweight dependency. Flask would need marshmallow/manual validation to match. |
| Index store | **SQLite** (WAL) | Zero-ops, single file in `data/`, fast enough for millions of rows, trivially backed up. Schema-versioned; rebuildable from source PGNs at any time (cache, not source of truth). |
| PGN parsing | **Two-layer: custom streaming scanner for indexing + python-chess for hydration** | python-chess has excellent SAN/RAV/NAG/comment fidelity but its reader parses movetext fully — too slow for index-only scans of huge files. The scanner never parses movetext; it only finds boundaries and tag lines. Verified empirically that python-chess 1.11 handles every quirk in the sample files. |
| Board state | **Server computes FEN per node during hydration** | UI never replays moves; every node carries its position. Costs response size (~100 bytes/node), saves all client-side chess logic and repeated recomputation. |
| Frontend | **Vanilla ES modules, no build step** | One dev, offline, no toolchain rot. ~1.5k lines of JS is well within no-framework territory. Board uses Unicode chess glyphs styled via CSS (no external assets). |
| Concurrency | Scan runs in a background thread; SQLite connection-per-operation with WAL | Keeps API responsive during multi-GB scans; progress polled via `GET /api/files/{id}`. |
| Source fidelity | Original bytes are never rewritten; index stores offsets; raw PGN endpoint returns exact source slice | Round-trip is guaranteed at the byte level regardless of any parser normalization. |

## 4. Parser strategy

**Layer A — boundary scanner (`scanner.py`), index time.** Binary line iteration with manual byte
offset accounting (`offset += len(line)`), so offsets are exact regardless of encoding. State
machine: `GAP → TAGS → MOVETEXT → (tag line seen) → boundary`. Crucially it tracks *brace-comment
state across lines* so a `[` at line start inside a multi-line `{comment}` is not misread as a new
game. Handles UTF-8 BOM, CRLF, `%` escape lines, `;` rest-of-line comments. Tag pairs are extracted
with one compiled regex per line; movetext is otherwise only scanned for `{`/`}`/`;`. Games that
never produce a valid tag section still become records (flagged `warning`) as long as movetext is
attributable; garbage between games is attached to the following boundary decision, never crashes
the scan.

**Layer B — hydrator (`parser.py`), read time.** Seek to `offset_start`, read
`offset_end - offset_start` bytes, decode UTF-8 (`errors="replace"`), feed to
`chess.pgn.read_game`. python-chess yields the full recursive game tree: `comment`,
`starting_comment`, `nags`, variations, `[FEN]/[SetUp]` starting positions, and collects
non-fatal issues in `game.errors` (surfaced as document warnings). The tree is converted
iteratively (explicit stack — nesting depth bounded, but no recursion-limit risk) into the
document model below.

**Known fidelity limits (python-chess, documented not hidden):** multiple consecutive brace
comments on one move are merged into one comment string; `;` comments are folded into brace-style
comments; escape lines (`%`) are dropped from the parsed model. The *original* text is always
recoverable via the raw-source endpoint.

## 5. Indexing strategy

- `files` row per registered path with fingerprint = (size, mtime_ns, SHA-1 of first+last 64 KiB).
  Re-scan only when fingerprint changes (or forced).
- Scan streams the file once, emits `(idx_in_file, offset_start, offset_end, headers, warning)`
  per game; inserted in batches of 500 inside transactions. Memory is O(one game's tag section).
- Progress = bytes consumed / file size, stored in an in-process registry, exposed over the API.
- Roster tags get dedicated indexed columns (event/site/date/round/white/black/result + eco,
  opening); all tags kept in `tag_json`. Search is `LIKE` over the dedicated columns (FTS5 is a
  documented upgrade).
- Schema version lives in `meta`; on mismatch the DB is rebuilt (it is a cache).

## 6. Document model (`models.py`)

```
GameDocument
├─ game_id, file_id, idx_in_file
├─ headers: dict[str, str]            # exact tag order preserved
├─ root: MoveNode                     # ply 0, holds starting FEN + pre-game comment
├─ warnings: [str]                    # parser errors, scan warnings
├─ result: str                        # termination marker
└─ source: str                        # exact original PGN slice

MoveNode
├─ id: int                            # preorder index, stable within a document
├─ san, uci: str | None               # None only on root
├─ move_number: int, color: 'w'|'b'
├─ fen: str                           # position AFTER the move (root: starting position)
├─ nags: [int], glyphs: [str]         # numeric + rendered (!, ?!, ±, …)
├─ comment: str                       # comment after the move
├─ starting_comment: str              # comment before first move of a variation
└─ children: [MoveNode]               # children[0] = main continuation, rest = sidelines
```

Explicit tree, never a flat list; variation order and nesting are preserved exactly as parsed.

## 7. API design (all under `/api`, JSON)

| Method & path | Purpose |
|---|---|
| `GET /health` | liveness, version, db status |
| `GET /files` | registered files + scan status/progress |
| `POST /files` `{path}` | register + scan in background |
| `POST /files/upload` | multipart upload → copies into `library/`, registers |
| `GET /discover` | unregistered `.pgn` files in watch dirs |
| `GET /files/{id}` | file detail incl. live progress |
| `POST /files/{id}/rescan` | force re-scan |
| `DELETE /files/{id}` | unregister (source file untouched) |
| `GET /files/{id}/games?q&offset&limit` | paged, filtered game list |
| `GET /games/{id}` | hydrated `GameDocument` |
| `GET /games/{id}/pgn` | exact original source slice (text/plain) |
| `POST /admin/reset` | drop and recreate the index DB |

Frontend served statically at `/`. Errors: consistent `{detail}` with 404/409/422 semantics.

## 8. UI route/view map (hash-routed SPA)

- `#/library` — file cards (status, game count, progress bar), discover/add/upload controls.
- `#/file/{id}` — game table (Event/Site/Date/Round/White/Black/Result), search box, paging.
- `#/game/{id}` — reader: board (left) + notation pane (right) + header strip + raw-PGN drawer.
  Keyboard: `←`/`→` step within current line, `↑`/`↓` cycle sibling variations at a branch point,
  `Home`/`End`, click any move token. Comments render as prose blocks in the notation flow;
  sidelines as indented, bordered sub-blocks (collapsible at depth ≥ 1); NAG glyphs attach to
  their move token. Current node highlighted and kept scrolled into view.

## 9. Performance strategy

- Index: O(file size) single pass, no movetext parse, batched inserts — the only whole-file cost.
- Read: O(selected game) — seek + read one span; list views are SQL paging, never hydration.
- Notation rendering: DOM built in one DocumentFragment; for documents > ~3,000 nodes rendering is
  chunked across animation frames so the tab never freezes.
- Board updates are FEN lookups (no replay). Node map is a flat `id → node` array client-side.
- Honest trade-off: per-node FENs inflate the game JSON (~100 B/node). At Chessable-chapter sizes
  (≤ a few thousand nodes) this is ≤ ~1 MB and the win in simplicity/latency is decisive.

## 10. Testing strategy

pytest; synthetic fixtures in `tests/fixtures/` cover each PGN feature in isolation; the user's
`samples/` files are wired in as first-class regression fixtures (auto-skipped if absent).
Layers: scanner unit tests (boundaries, offsets, BOM/CRLF, comment-brace traps, malformed),
parser fidelity tests (comments, NAGs, RAVs, FEN starts, round-trip re-parse), service tests
(fingerprint/re-scan), API integration tests (httpx/TestClient), large-file test (generated
multi-thousand-game file, asserts index without hydration), sample regression tests (exact game
counts 185/351, annotation spot checks). UI smoke via manual checklist + browser preview.

## 11. Release strategy

Single folder, `python -m venv` + `pip install -r requirements.txt`; run via
`python -m pgnreader serve`. CLI subcommands: `serve`, `index <path>`, `reset`.
`data/` (DB + logs) is disposable cache — backup is optional, rebuild is one command.
CHANGELOG.md tracks releases; schema version bump ⇒ automatic rebuild.

## Build plan & risk order

1. Scaffold/config/DB (low risk, foundation)
2. **Scanner** (highest risk: correctness of offsets & boundaries on real Chessable exports)
3. **Parser/document model** (second risk: annotation fidelity)
4. Service + API
5. Frontend reader (third risk: variation rendering usability)
6. Tests green, browser verification, packaging

Fallbacks: if the custom scanner proved unreliable → python-chess `read_headers` (slower but
correct); if per-node FEN payloads proved too big → client-side replay with chess logic in JS;
if vanilla-JS notation rendering proved unmanageable → preact (10 kB, vendored). None were needed.
