# Offline PGN Reader

A fully offline PGN reader and study interface: Node.js/TypeScript runtime +
browser UI, built for reading large, heavily annotated PGN files (Chessable-style
course exports, game collections, opening files) on a normal laptop. No cloud, no
SaaS, no external assets — everything runs from this folder.

![stack](https://img.shields.io/badge/stack-Node%2FTypeScript%20%2B%20SQLite%20%2B%20vanilla%20JS-334)

## Features

- **Streaming indexer** — scans multi-hundred-MB PGN files in one pass with
  bounded memory, storing byte offsets and headers in a local SQLite cache.
  The repeatable TypeScript production benchmark is documented in [the scan benchmark report](docs/benchmarks/typescript-scan.md).
- **Lazy game loading** — opening a game reads the indexed byte span plus
  bounded fingerprint samples; it never scans the full source.
- **Full annotation fidelity** — brace comments (multi-line), semicolon
  comments, NAGs (numeric and `!?`-style suffixes), recursive variations,
  starting comments, FEN/SetUp starting positions. The move tree is explicit;
  the indexed source span is preserved separately from parser normalization.
- **Chessable-style reader** — board + variation-aware notation with prose
  comments in the reading flow, sidelines indented and collapsible, NAG
  glyphs, current-move highlight, keyboard-first navigation.
- **Graphics annotations** — `[%cal]` arrows and `[%csl]` square highlights
  embedded in comments are drawn on the board (Lichess brush colors) instead
  of cluttering the comment text.
- **Malformed-file tolerance** — broken games are indexed, flagged and
  readable to the extent they parse; neighboring games remain readable. An
  unterminated brace comment can still merge records (see Known limitations).
- **Change detection** — source fingerprints mark changed indexes stale;
  unchanged ready sources skip rescans, and `--force` overrides the skip.

## Requirements

- Node.js 24.11.1 and npm 11.6.0 for the documented setup (see `.nvmrc`; the
  package accepts Node.js `>=22.14.0 <27`)
- A Chromium-based browser; Playwright Chromium is used by the automated checks

## Setup (one time)

Install the production Node.js runtime:

```bash
cd offline-pgn-reader
nvm use
npm install
```

Everything after this point is fully offline.

## Run

Production starts the single Node.js/TypeScript process at the local address:

```bash
npm start
# → http://127.0.0.1:8642
```

For local development, `npm run dev` starts the same TypeScript process. TypeScript
checks, behavior contracts, and browser verification are available together.
Install the Playwright browser once:

```bash
npm run typecheck
npm test
npm run test:contracts
npx playwright install chromium
npm run test:browser
```

`npm run test:all` runs type checking, Vitest, behavior contracts, and Playwright
in one command. The browser command starts an isolated Node
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
| Run the production Scan benchmark | `npm run benchmark -- --games 1000000` |
| Remove one indexed file | Library **Remove** action or `DELETE /api/files/{id}` |
| Run behavior contracts alone | `npm run test:contracts` |

Running `npm start` with no subcommand uses the configured host and port. The
CLI `index` command skips an unchanged ready file; `--force` replaces its
index. `serve --host` and `serve --port` override the environment defaults.
`--reload` is accepted for CLI compatibility but is currently ignored by the
TypeScript process.

## Keyboard shortcuts (reader)

`→`/`←` step through the current line · `↓`/`↑` cycle sibling variations ·
`Home`/`End` line start/end · `[`/`]` previous/next game · `f` flip board ·
`p` raw PGN source · the `?` button opens help

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

`PGNREADER_*` values are consumed by the Node.js process, which owns the database
and browser routes. Relative paths resolve from the project root; `~` and
absolute paths are supported. `PGNREADER_WATCH_DIRS` uses `:` on macOS/Linux and
`;` on Windows.

## Data & backup

`data/index.sqlite3` is a **disposable cache** derived from your PGN files —
your PGN sources are never modified. Back up your PGN files; the index can
always be rebuilt (`reset` + re-index). The schema is versioned; upgrades
that change it rebuild the cache automatically. The TypeScript server logs to
the console.

## Architecture

See [docs/DESIGN.md](docs/DESIGN.md) for the full architecture record and
[docs/VALIDATION.md](docs/VALIDATION.md) for the validation report. Short
version:

```
frontend/            vanilla-JS SPA (board, notation tree, library)
frontend/pieces/     local CBurnett SVG chess pieces
src/server.ts        Fastify routes + static hosting
src/library.ts       Library intake and Scan lifecycle
src/scan-worker.ts   narrow worker adapter for background scans
src/index.ts         Index persistence, replacement, reset, and status
src/source.ts        source fingerprints and bounded source-byte spans
src/projection.ts    Index/GameDocument response projection + errors
src/scanner.ts       streaming boundary scanner (index layer, no movetext parse)
src/hydration.ts     per-game hydration via chess.js → document model
src/database.ts      SQLite schema and connection lifecycle (WAL)
tests/               shared PGN source and contract fixtures
tests-ts/             TypeScript behavior and integration tests
```

## Known limitations

- Consecutive brace comments on one move are merged (parser behavior);
  semicolon comments are preserved but rendered as brace-style comments.
  The indexed source span is available via *Raw PGN source* while the source
  fingerprint still matches (decoded as UTF-8 for the HTTP/text response).
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
