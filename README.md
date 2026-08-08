# Offline PGN Reader

A fully offline PGN reader and study interface: Node.js/TypeScript runtime +
browser UI, built for reading large, heavily annotated PGN files (Chessable-style
course exports, game collections, opening files) on a normal laptop. The Python
runtime remains available only as the documented rollback path and test oracle.
No cloud, no SaaS, no external assets — everything runs from this folder.

![stack](https://img.shields.io/badge/stack-Node%2FTypeScript%20%2B%20SQLite%20%2B%20vanilla%20JS-334)

## Features

- **Streaming indexer** — scans multi-hundred-MB PGN files in one pass with
  constant memory, storing byte offsets and headers in a local SQLite cache.
  A recorded pre-cutover reference run indexed a 231 MB / 1,000,000-game file
  in ~20 s at ~38 MB RSS.
- **Lazy game loading** — opening a game seeks straight to its byte span;
  nothing else in the file is read.
- **Full annotation fidelity** — brace comments (multi-line), semicolon
  comments, NAGs (numeric and `!?`-style suffixes), recursive variations,
  starting comments, FEN/SetUp starting positions. The move tree is explicit;
  the indexed source span remains available without parser normalization.
- **Chessable-style reader** — board + variation-aware notation with prose
  comments in the reading flow, sidelines indented and collapsible, NAG
  glyphs, current-move highlight, keyboard-first navigation.
- **Graphics annotations** — `[%cal]` arrows and `[%csl]` square highlights
  embedded in comments are drawn on the board (Lichess brush colors) instead
  of cluttering the comment text.
- **Malformed-file tolerance** — broken games are indexed, flagged and
  readable to the extent they parse; they never break the rest of the file.
- **Change detection** — files are fingerprinted; re-scan happens only when
  content changes (or is forced).

## Requirements

- Node.js 24.11.1 and npm 11.6.0 for the documented setup (see `.nvmrc`; the
  package accepts Node.js `>=22.14.0 <27`)
- Python 3.11+ (tested on 3.14) for rollback and the oracle test suite
- A Chromium-based browser; Playwright Chromium is used by the automated checks

## Setup (one time)

Install the production Node.js runtime:

```bash
cd offline-pgn-reader
nvm use
npm install
```

Set up the optional Python rollback runtime and test oracle:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Everything after this point is fully offline.

## Run

Production starts the single Node.js/TypeScript process at the local address:

```bash
npm start
# → http://127.0.0.1:8642
```

For local development, `npm run dev` starts the same TypeScript process. The
Python application is not part of the production startup path. It remains an
optional rollback runtime and compatibility oracle. Run it with its own port
and data directory so it cannot share the production cache:

```bash
PGNREADER_DATA_DIR=./data-python PGNREADER_PORT=8643 .venv/bin/python -m pgnreader serve
```

TypeScript checks, the Python oracle, cross-runtime parity, and browser
verification are available together. Install the Playwright browser once:

```bash
npm run typecheck
npm test
npm run test:python
npm run test:parity
npx playwright install chromium
npm run test:browser
```

`npm run test:all` runs type checking, Vitest, the Python oracle, parity checks,
and Playwright in one command. The browser command starts an isolated Node
server automatically; it does not use the default `data/` cache.

Files in `samples/` and `library/` are auto-discovered on the Library page —
one click indexes them. You can also paste any absolute path, or upload a
copy (stored in `library/`).

## Commands

| Action | Command |
|---|---|
| Start production server | `npm start` |
| Start server with CLI options | `npm start -- serve [--host HOST] [--port PORT] [--reload]` |
| Index one or more files | `npm start -- index [--force] PATH...` |
| Reset the index cache | `npm start -- reset` |
| Show CLI help | `npm start -- --help` |
| Remove one indexed file | Library **Remove** action or `DELETE /api/files/{id}` |
| Run the Python oracle alone | `npm run test:python` |

Running `npm start` with no subcommand uses the configured host and port. The
CLI `index` command skips an unchanged ready file; `--force` replaces its
index. `serve --host` and `serve --port` override the environment defaults.
`--reload` is accepted for CLI compatibility but is currently ignored by the
TypeScript process.

## Keyboard shortcuts (reader)

`→`/`←` step through the current line · `↓`/`↑` cycle sibling variations ·
`Home`/`End` line start/end · `[`/`]` previous/next game · `f` flip board ·
`p` raw PGN source · `?` help

## Configuration

Environment variables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `PGNREADER_HOST` / `PGNREADER_PORT` | `127.0.0.1` / `8642` | bind address |
| `PGNREADER_DATA_DIR` | `./data` | SQLite index cache |
| `PGNREADER_WATCH_DIRS` | `./samples:./library` | auto-discover dirs (path-separator separated) |
| `PGNREADER_UPLOAD_DIR` | `./library` | where uploads are copied |
| `PGNREADER_DEBUG` | off | verbose console logging (`1`, `true`, or `yes`) |
| `PGNREADER_MAX_GAME_BYTES` | 8 MiB | per-game hydration safety cap |

`PGNREADER_*` values are consumed by both runtimes. The Node.js process is the
production owner of the database and browser routes; Python must use a separate
data directory (and normally a separate port) when it is run as the rollback or
oracle process. Relative paths resolve from the project root; `~` and absolute
paths are supported. `PGNREADER_WATCH_DIRS` uses `:` on macOS/Linux and `;` on
Windows.

## Data & backup

`data/index.sqlite3` is a **disposable cache** derived from your PGN files —
your PGN sources are never modified. Back up your PGN files; the index can
always be rebuilt (`reset` + re-index). The schema is versioned; upgrades
that change it rebuild the cache automatically. The TypeScript server logs to
the console; the optional Python runtime also writes its rotating
`pgnreader.log` inside its selected data directory.

## Architecture

See [docs/DESIGN.md](docs/DESIGN.md) for the full architecture record and
[docs/VALIDATION.md](docs/VALIDATION.md) for the validation report. Short
version:

```
frontend/            vanilla-JS SPA (board, notation tree, library)
frontend/pieces/     local CBurnett SVG chess pieces
src/server.ts        Fastify routes + static hosting (production)
src/library.ts       library ops, background scans, retrieval
src/scanner.ts       streaming boundary scanner (index layer, no movetext parse)
src/hydration.ts     per-game hydration via chess.js → document model
src/database.ts      SQLite cache (schema-versioned, WAL)
pgnreader/           Python rollback runtime and oracle implementation
tests/               Python oracle and shared regression fixtures
tests-ts/             TypeScript and cross-runtime parity tests
```

## Known limitations

- Consecutive brace comments on one move are merged (parser behavior);
  semicolon comments are preserved but rendered as brace-style comments.
  The original source span is always available via *Raw PGN source* (decoded as
  UTF-8 for the HTTP/text response).
- `%`-escape lines are honored (skipped) but not represented in the model.
- An **unterminated** `{` comment in a malformed file swallows subsequent
  games into one record until the comment closes; the 8 MiB per-game cap
  refuses an oversized hydration span rather than allocating it without a
  bound.
- Header search uses SQL `LIKE` (≈1.5 s across 1M games). Fine for course
  files; an FTS index is the planned upgrade for huge databases.
- Arrows are drawn as straight lines (Lichess bends knight-move arrows;
  this reader does not). Shapes found in a variation's *starting comment*
  (pre-move position) are shown on the post-move position of that node.
- Single-user by design (localhost is the default bind address); no PGN
  editing/writing in v1.

## Credits

Chess pieces: the **CBurnett** SVG set by Colin M.L. Burnett (the Lichess
default set), vendored locally in `frontend/pieces/` — licensed
GPLv2+ (also available under BSD/GFDL). Source:
https://github.com/lichess-org/lila/tree/master/public/piece/cburnett
