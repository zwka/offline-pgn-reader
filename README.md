# Offline PGN Reader

A fully offline PGN reader and study interface: Python runtime + browser UI,
built for reading large, heavily annotated PGN files (Chessable-style course
exports, game collections, opening files) on a normal laptop. A Node.js/TypeScript
bootstrap runtime is available for the incremental migration and serves the same
local browser shell and health path. No cloud, no SaaS, no external assets —
everything runs from this folder.

![stack](https://img.shields.io/badge/stack-FastAPI%20%2B%20SQLite%20%2B%20vanilla%20JS-334)

## Features

- **Streaming indexer** — scans multi-hundred-MB PGN files in one pass with
  constant memory (~38 MB RSS for a 231 MB / 1,000,000-game file, ~20 s),
  storing byte offsets and headers in a local SQLite cache.
- **Lazy game loading** — opening a game seeks straight to its byte span;
  nothing else in the file is read.
- **Full annotation fidelity** — brace comments (multi-line), semicolon
  comments, NAGs (numeric and `!?`-style suffixes), recursive variations,
  starting comments, FEN/SetUp starting positions. The move tree is explicit;
  the original source bytes are always recoverable per game.
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

- Python 3.11+ (tested on 3.14)
- A Chromium-based browser (built for Brave; Chrome/Edge work identically)

## Setup (one time)

Install the Node.js migration runtime:

```bash
cd offline-pgn-reader
nvm use
npm install
```

Set up the pre-cutover Python runtime and test oracle:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Everything after this point is fully offline.

## Run

The Node.js/TypeScript bootstrap uses Node.js `24.11.1` and npm `11.6.0` (see
`.nvmrc` and `package.json`). Install its dependencies and start the same
local address with:

```bash
npm install
npm run dev
# → http://127.0.0.1:8642
```

Until the parity gate and release acceptance are complete, the current Python
application remains the full-reader path at the same address and is retained
for rollback and oracle validation:

```bash
.venv/bin/python -m pgnreader serve
```

TypeScript checks and browser verification are available alongside the Python
oracle. Install the Playwright browser once before the smoke test:

```bash
npm run typecheck
npm test
npx playwright install chromium
npm run test:browser
npm run test:python
```

`npm run test:all` runs those checks in one command.

Files in `samples/` and `library/` are auto-discovered on the Library page —
one click indexes them. You can also paste any absolute path, or upload a
copy (stored in `library/`).

## Commands

| Action | Command |
|---|---|
| Start server | `.venv/bin/python -m pgnreader serve` |
| Index file(s) from the terminal | `.venv/bin/python -m pgnreader index path/to/file.pgn` |
| Force re-index | `.venv/bin/python -m pgnreader index --force path/to/file.pgn` |
| Reset the index cache | `.venv/bin/python -m pgnreader reset` |
| Run tests | `.venv/bin/python -m pytest` |

## Keyboard shortcuts (reader)

`→`/`←` step through the current line · `↓`/`↑` cycle sibling variations ·
`Home`/`End` line start/end · `[`/`]` previous/next game · `f` flip board ·
`p` raw PGN source · `?` help

## Configuration

Environment variables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `PGNREADER_HOST` / `PGNREADER_PORT` | `127.0.0.1` / `8642` | bind address |
| `PGNREADER_DATA_DIR` | `./data` | SQLite index + logs |
| `PGNREADER_WATCH_DIRS` | `./samples:./library` | auto-discover dirs (`:`-separated) |
| `PGNREADER_UPLOAD_DIR` | `./library` | where uploads are copied |
| `PGNREADER_DEBUG` | off | verbose console logging |
| `PGNREADER_MAX_GAME_BYTES` | 8 MiB | per-game hydration safety cap |

## Data & backup

`data/index.sqlite3` is a **disposable cache** derived from your PGN files —
your PGN sources are never modified. Back up your PGN files; the index can
always be rebuilt (`reset` + re-index). The schema is versioned; upgrades
that change it rebuild the cache automatically.

## Architecture

See [docs/DESIGN.md](docs/DESIGN.md) for the full architecture record and
[docs/VALIDATION.md](docs/VALIDATION.md) for the validation report. Short
version:

```
frontend/            vanilla-JS SPA (board, notation tree, library)
pgnreader/api.py     FastAPI routes + static hosting
pgnreader/service.py library ops, background scans, retrieval
pgnreader/scanner.py streaming boundary scanner (index layer, no movetext parse)
pgnreader/parser.py  per-game hydration via python-chess → document model
pgnreader/models.py  explicit move-tree document model
pgnreader/db.py      SQLite cache (schema-versioned, WAL)
tests/               pytest suite incl. samples/ regression fixtures
```

## Known limitations

- Consecutive brace comments on one move are merged (python-chess behavior);
  semicolon comments are preserved but rendered as brace-style comments.
  The exact original text is always available via *Raw PGN source*.
- `%`-escape lines are honored (skipped) but not represented in the model.
- An **unterminated** `{` comment in a malformed file swallows subsequent
  games into one record until the comment closes; the 8 MiB per-game cap
  turns the worst case into a clear error rather than a hang.
- Header search uses SQL `LIKE` (≈1.5 s across 1M games). Fine for course
  files; an FTS index is the planned upgrade for huge databases.
- Arrows are drawn as straight lines (Lichess bends knight-move arrows;
  this reader does not). Shapes found in a variation's *starting comment*
  (pre-move position) are shown on the post-move position of that node.
- Single-user, localhost-only by design; no PGN editing/writing in v1.

## Credits

Chess pieces: the **CBurnett** SVG set by Colin M.L. Burnett (the Lichess
default set), vendored locally in `frontend/pieces/` — licensed
GPLv2+ (also available under BSD/GFDL). Source:
https://github.com/lichess-org/lila/tree/master/public/piece/cburnett
