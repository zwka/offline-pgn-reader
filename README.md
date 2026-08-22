# Offline PGN Reader

Read and study chess games from PGN files on your computer.

[PGN](https://en.wikipedia.org/wiki/Portable_Game_Notation) (Portable Game
Notation) is the text format used to store chess games. Offline PGN Reader
builds a local Library from your `.pgn` files. You can search game records,
open a game on a chessboard, read its comments, and follow alternate moves.

The app runs at a local address on your computer. It does not need an account,
cloud service, or internet connection while you use it. Your original PGN
sources are not sent to a cloud service or changed in place.

![stack](https://img.shields.io/badge/stack-Node%2FTypeScript%20%2B%20SQLite%20%2B%20vanilla%20JS-334)

## Start Here

### What you need

- Node.js 24.11.1 and npm 11.x for the recommended setup. The project also
  accepts Node.js `>=22.14.0 <27` and npm `>=11 <12`.
- A Chromium-based browser such as Chrome, Edge, or Brave.
- One or more `.pgn` files. The project includes example sources in `samples/`.

The first `npm install` downloads the software packages that run the app. The
app itself works offline after that installation is complete.

### Install once

Open a terminal, move to this project folder, and run:

```bash
cd /path/to/offline-pgn-reader
nvm use
npm install
```

`nvm use` selects the Node.js version recorded in `.nvmrc` (`24.11.1`). If you
do not use `nvm`, install a supported Node.js version first, then run only
`npm install` from the project folder. See [Troubleshooting](#troubleshooting)
if `nvm` or `npm` is not available.

### Start the app

Run:

```bash
npm start
```

Open <http://127.0.0.1:8642> in your browser. Keep the terminal window open
while you use the app; the local server runs there. Press `Ctrl+C` in that
terminal when you want to stop it.

### Read your first game

1. Open the **Library** page. PGN sources in `samples/` and `library/` appear
   automatically.
2. Add a source. Click **Index** beside a discovered source, paste the full
   path to a `.pgn` file and click **Index path**, or choose **Upload copy...**
   to place a copy in `library/`.
3. Wait until the source shows `ready` and a game count. This means the Scan
   has finished and the Index is ready to use. Large sources can take longer.
4. Click the source name to see its game records. Use the search box to filter
   by player, event, site, date, opening, or ECO code.
5. Click a game record to open the Reader. Click moves in the notation or use
   the board controls to move through the game.

### Reader controls

The Reader shows the board, move notation, comments, game tags, and alternate
continuations called Variations. Comments that contain arrows or highlighted
squares are drawn on the board. Use **Raw PGN source** when you need to inspect
the original source text.

| Key or control | Action |
|---|---|
| `Right` / `Left` | Next / previous move in the current Variation |
| `Down` / `Up` | Cycle through alternate Variations at the current position |
| `Home` / `End` | Go to the start / end of the current Variation |
| `[` / `]` | Open the previous / next game in the source |
| `f` | Flip the board |
| `p` | Show or hide the Raw PGN source |
| `Esc` | Close the keyboard-shortcut help dialog |

Click the `?` button in the top bar to see these shortcuts in the app.

## What the app supports

- Large PGN sources are scanned in one pass with bounded memory. The Index
  stores game locations and tag pairs so opening one game does not require
  reading the whole source again. See [the scan benchmark report](docs/benchmarks/typescript-scan.md).
- Comments in braces, comments that start with a semicolon, move-quality marks
  such as `!` and `?`, nested Variations, comments before the first move, and
  custom starting positions are retained as far as the source allows.
- Malformed game records are flagged with warnings instead of preventing all
  neighboring game records from being indexed.
- Source fingerprints detect changes. A changed source is marked `stale` until
  you use **Re-scan**. An unchanged source can skip a repeated Scan.
- Arrows (`[%cal]`) and square highlights (`[%csl]`) inside comments are shown
  on the board.

## Troubleshooting

Read both the message in the browser and the message in the terminal. The
terminal is where the local server reports startup and Scan errors.

### `nvm` or `node` is not available

Install `nvm` and then run `nvm install` followed by `nvm use`, or install
Node.js 24.11.1 directly. Check the versions with:

```bash
node --version
npm --version
```

Use Node.js `>=22.14.0 <27` and npm `>=11 <12`, then run `npm install` again
from the project folder.

### `npm install` fails

The first installation needs internet access because npm downloads dependencies.
Check that you are in the folder containing `package.json`, use a supported
Node.js version, and run `npm install` again. A later app start does not need
internet access.

### The browser cannot connect

Keep the terminal running after `npm start`. If the server stopped, start it
again and open <http://127.0.0.1:8642>. If the terminal shows a startup error,
fix that error first.

### Port `8642` is already in use

Another process may already be using the default port. Stop the other process,
or start this app on another port:

```bash
npm start -- serve --port 8643
```

Then open <http://127.0.0.1:8643>.

### The Library is empty

The automatic list only includes `.pgn` files inside the configured discovery
directories. Use **Upload copy...** for a file anywhere on your computer, or
paste its absolute path into **Add files**. The path must name a file, not a
folder, and the file name must end in `.pgn`.

### A source stays `scanning` or shows `error`

Large sources can take time. Wait for the progress indicator to finish. For an
`error`, read the error text on the source card and the terminal output, check
that the PGN source still exists and can be read, then click **Re-scan**.

For a command-line Scan, quote paths that contain spaces:

```bash
npm start -- index --force "/path/to/Chess files/study.pgn"
```

### A source is marked `stale`

The PGN source changed after its Index was built. Click **Re-scan (changed)**
to replace its game records with records from the current source.

### A game has a warning or will not open

Warnings identify malformed parts of a PGN source. The game may still be
readable; open it and check the warning details or **Raw PGN source**. If the
source still exists but was edited or replaced, run **Re-scan** first. If it was
moved or renamed, use **Remove** and add the new path.

One game record can be read only up to the default 8 MiB safety limit. A
malformed source with an unterminated comment can make several games look like
one very large record. Correct the PGN source, or increase the limit with
`PGNREADER_MAX_GAME_BYTES` as described in [Configuration](#configuration).

### I used **Reset Library** or **Remove**

Those actions remove records from the local Index. They do not delete or edit
the PGN source. Add the source again and wait for `ready` if you need to
rebuild its records.

## Commands

Run these commands from the project folder:

| Action | Command |
|---|---|
| Start the local server | `npm start` |
| Start on a chosen port | `npm start -- serve --port PORT` |
| Scan one or more PGN sources | `npm start -- index PATH...` |
| Scan again even if unchanged | `npm start -- index --force PATH...` |
| Reset the local Index | `npm start -- reset` |
| Show command help | `npm start -- --help` |
| Start the development server | `npm run dev` |

Running `npm start` with no subcommand uses the configured host and port. The
`index` command skips an unchanged source that is already `ready`; `--force`
replaces its Index. The `serve --host` and `serve --port` options override the
configured defaults. `--reload` is accepted for command-line compatibility but
currently has no effect.

## Configuration

All settings are optional. Set them in the environment before starting the
server or running a command.

| Variable | Default | Meaning |
|---|---|---|
| `PGNREADER_HOST` | `127.0.0.1` | Local address to bind |
| `PGNREADER_PORT` | `8642` | Local server port |
| `PGNREADER_DATA_DIR` | `./data` | Directory for the local Index database |
| `PGNREADER_WATCH_DIRS` | `./samples:./library` | Directories where the Library discovers `.pgn` sources |
| `PGNREADER_UPLOAD_DIR` | `./library` | Directory where uploaded copies are stored |
| `PGNREADER_DEBUG` | off | More detailed terminal logging (`1`, `true`, or `yes`) |
| `PGNREADER_MAX_GAME_BYTES` | 8 MiB | Maximum bytes read for one game record |

Relative paths start at the project folder. `~` and absolute paths are also
supported. Separate multiple discovery directories with `:` on macOS/Linux
and `;` on Windows.

For example, the command-line port option is usually the simplest way to use a
different port:

```bash
npm start -- serve --port 8643
```

## Files and backup

`data/index.sqlite3` is a local Index derived from your PGN sources. It can be
rebuilt at any time. Back up the PGN sources themselves; the Index is not the
source of truth.

- **Index path** keeps the original PGN source where it is.
- **Upload copy...** copies the source into `library/` before scanning it.
- **Remove** removes only that source's records from the Index.
- **Reset Library** removes all records from the Index but leaves PGN sources
  untouched.

The database schema is versioned and is rebuilt automatically when a schema
upgrade requires it.

## For developers

The runtime is a single TypeScript process with a vanilla JavaScript browser
interface. Run the checks with:

```bash
npm run typecheck
npm test
npm run test:contracts
npx playwright install chromium
npm run test:browser
```

`npx playwright install chromium` is needed once for browser tests and may need
internet access. `npm run test:all` runs type checking, contract tests,
TypeScript tests, and browser tests together. The browser tests start an
isolated server and do not use the default `data/` Index.

The production Scan benchmark can be run with:

```bash
npm run benchmark -- --games 1000000
```

See [docs/DESIGN.md](docs/DESIGN.md) for the architecture record and
[docs/VALIDATION.md](docs/VALIDATION.md) for the validation report. The main
source areas are:

```
frontend/            Browser interface (board, notation tree, Library)
frontend/pieces/     Local CBurnett SVG chess pieces
src/server.ts        Fastify routes and static hosting
src/library.ts       Library intake and Scan lifecycle
src/scan-worker.ts   Background Scan worker adapter
src/index.ts         Index persistence, replacement, reset, and status
src/source.ts        Source fingerprints and bounded source-byte spans
src/projection.ts    Index/GameDocument response projection and errors
src/scanner.ts       Streaming game-boundary scanner
src/hydration.ts     Per-game hydration through chess.js
src/database.ts      SQLite schema and connection lifecycle
tests/               Shared PGN sources and contract fixtures
tests-ts/            TypeScript behavior and integration tests
```

## Known limitations

- Consecutive brace comments on one move are merged. Semicolon comments are
  preserved in the source but displayed as brace-style comments in the Reader.
  The **Raw PGN source** view shows the indexed source span while the source
  fingerprint still matches.
- `%` escape lines are honored and skipped, but they are not represented in the
  GameDocument.
- An unterminated `{` comment in a malformed source can combine subsequent
  games into one record until the comment closes.
- Header search uses SQL `LIKE`. It is suitable for course files, but search
  across about one million games takes roughly 1.5 seconds. A full-text search
  index is a planned upgrade for very large Libraries.
- Arrows are drawn as straight lines. Knight-move arrows are not bent as they
  are in Lichess. Shapes in a Variation's starting comment are shown on that
  node's post-move position.
- The app is single-user by design and binds to localhost by default. PGN
  editing and writing are not included in v1.

## Credits

Chess pieces: the **CBurnett** SVG set by Colin M.L. Burnett, the Lichess
default set, vendored locally in `frontend/pieces/`. It is licensed under
GPLv2+ and is also available under BSD/GFDL. Source:
<https://github.com/lichess-org/lila/tree/master/public/piece/cburnett>
