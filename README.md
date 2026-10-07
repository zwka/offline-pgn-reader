# Offline PGN Reader

Read and study chess games from PGN files in a browser on a computer or phone.

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

Build the browser client, then start the local server:

```bash
npm run build:mobile
npm start
```

Open <http://127.0.0.1:8642> in a browser. The same mobile PWA runs at phone
and desktop viewport sizes. Keep the terminal open while you use the app.
Press `Ctrl+C` in that terminal when you want to stop it.

### Use the browser app

The browser app is a static mobile PWA. It scans and persists multiple imported
`.pgn` sources in a Web Worker and a versioned IndexedDB Mobile Library. One
retained source is active at a time, and the source list can be switched without
opening a Game automatically. The PWA does not call the server API or use its
SQLite Index.
A phone needs one initial online load over HTTPS, or installation while online,
to receive the PWA shell and service-worker cache. After that setup, the
persisted Mobile Library and Reader work offline.

The mobile source limit is 50 MiB and the per-GameDocument safety limit is 8
MiB. Game records have no artificial total-count limit; the list renders at
most 50 records per page. Imported sources are scanned separately and become
active only after their source bytes have been read and their IndexedDB Mobile
Library snapshot is saved. An imported source keeps its user-visible filename
as its **Source name**; the name must end in `.pgn`, and retained names are
unique case-insensitively. A cancelled, failed, oversized, or storage-failing
import leaves retained sources and the previous active selection unchanged. The
mobile Reader retains
custom FEN starts, Variations, comments, NAGs, graphics, ordered duplicate Tag
pairs, warnings, the raw PGN source text, and adjacent-game navigation.

For a local browser test, build the client and serve the generated `mobile/`
directory over HTTP:

```bash
npm run build:mobile
python3 -m http.server 8431 --bind 127.0.0.1 --directory mobile
```

Open <http://127.0.0.1:8431>. The static server is only needed to load browser
modules and workers; no Node process is needed while using the mobile client.

To open the PWA on a phone, use a temporary HTTPS Cloudflare Quick Tunnel. The
tunnel exposes the static mobile build.

1. Install `cloudflared`. On macOS with Homebrew, run:

   ```bash
   brew install cloudflared
   ```

   For other operating systems, use the installation method in [Cloudflare's
   `cloudflared` documentation](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
2. From the project folder, install dependencies if needed, build the client,
   and start the static server:

   ```bash
   nvm use
   npm install
   npm run build:mobile
   python3 -m http.server 8431 --bind 127.0.0.1 --directory mobile
   ```

   Leave this terminal running. `npm install` is needed only when the project
   dependencies have not been installed yet or `package-lock.json` changes.
3. In a second terminal, start the tunnel:

   ```bash
   cloudflared tunnel --url http://127.0.0.1:8431
   ```

4. Open the `https://...trycloudflare.com` URL printed by `cloudflared` in the
   phone's browser. Leave both terminals running while the phone uses the
   tunnel. The URL is temporary and can change when the tunnel restarts.

The build includes Android Chrome/iOS Safari manifest metadata, local icons, and
a versioned service-worker precache. The current generated cache is
`offline-pgn-reader-mobile-v5`. Increment `CACHE_VERSION` in
`build-mobile.mjs` and rerun `npm run build:mobile` for a release that should
replace the cached application shell; the Mobile Library remains in IndexedDB
across that update. The current Mobile Library snapshot schema is v3. Snapshots
from v1 (one source) and v2 (multiple sources without Resume bookmarks) migrate
on restore; source bytes and Game records are retained, and older snapshots
start with no Resume bookmarks. For a permanent phone installation, publish the
complete `mobile/` directory through any HTTPS host. The Mobile Library
persistence applies only to this PWA. The Node/Fastify/SQLite server remains
available for its API and CLI workflows, but it does not provide a second
browser UI.

### Read your first Game record

1. Choose **Choose PGN source** and select a local `.pgn` file.
2. Wait until the source shows `ready` and a Game record count.
3. Use **Search metadata** to filter by player, event, site, date, opening, or
   ECO code.
4. Choose a Game record to open the Reader. Use the notation or board controls
   to move through the game.

### Reader controls

The Reader shows the board, move notation, comments, game tags, and alternate
continuations called Variations. Comments that contain arrows or highlighted
squares are drawn on the board. Use **Raw PGN source** when you need to inspect
the original source text.

| Key or control | Action |
|---|---|
| `Right` / `Left` | Next / previous move in the current Variation |
| `Down` / `Up` | Cycle through alternate Variations at the current position |
| `Home` / `End` | Go to the game start / end of the current Variation |
| `[` / `]` | Open the previous / next game in the source |
| `f` | Flip the board |
| `p` | Show or hide the Raw PGN source |

## What the app supports

- The browser Scan reads an imported source in one pass with bounded memory.
  The PWA retains source bytes and Game records in the Mobile Library.
- Comments in braces, comments that start with a semicolon, move-quality marks
  such as `!` and `?`, nested Variations, comments before the first move, and
  custom starting positions are retained as far as the source allows.
- Malformed game records are flagged with warnings instead of preventing all
  neighboring game records from being indexed.
- Arrows (`[%cal]`) and square highlights (`[%csl]`) inside comments are shown
  on the board.

## Server and CLI support

- Large PGN sources are scanned in one pass with bounded memory. The server
  Index stores game locations and tag pairs so opening one game does not
  require reading the whole source again. See [the scan benchmark report](docs/benchmarks/typescript-scan.md).
- Source fingerprints detect changes. The server marks a changed source `stale`
  until you rescan it. An unchanged source can skip a repeated Scan.

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

### The Mobile Library is empty

Choose **Choose PGN source** and select a file whose name ends in `.pgn`.

### A mobile import fails

Read the error below the source status. Check that the selected file is readable,
has a `.pgn` name, and is within the 50 MiB source limit before importing it
again.

### A server Scan stays `scanning` or shows `error`

Large server sources can take time. Read the terminal output or query the server
API for the Scan status. To rescan a source from the CLI, quote paths that
contain spaces:

```bash
npm start -- index --force "/path/to/Chess files/study.pgn"
```

### A server source is marked `stale`

The PGN source changed after its server Index was built. Run
`npm start -- index --force PATH` to replace its Game records.

### A Game record has a warning or will not open

Warnings identify malformed parts of a PGN source. The game may still be
readable; open it and check the warning details or **Raw PGN source**. If the
source still exists but was edited or replaced, import it again. The server CLI
can rescan a moved source with `npm start -- index --force PATH`.

A mobile Game record can be read only up to the 8 MiB safety limit. A malformed
source with an unterminated comment can make several games look like one very
large record. Correct the PGN source before importing it. The PWA also limits a
source to 50 MiB.

### I removed a retained source

**Remove source** deletes that source from the browser Mobile Library. It does
not delete a file on disk or change the server Index.

### I used server **reset** or **remove**

Those commands remove records from the server Index. They do not delete or edit
the PGN source. Run `npm start -- index PATH` again when you need to rebuild the
records.

## Commands

Run these commands from the project folder:

| Action | Command |
|---|---|
| Build the browser client | `npm run build:mobile` |
| Start the local server | `npm start` |
| Start on a chosen port | `npm start -- serve --port PORT` |
| Scan one or more PGN sources | `npm start -- index PATH...` |
| Scan again even if unchanged | `npm start -- index --force PATH...` |
| Reset the local Index | `npm start -- reset` |
| Show command help | `npm start -- --help` |
| Start the development server | `npm run dev` |
| Typecheck and build generated artifacts | `npm run build` |
| Check documentation links and generated claims | `npm run check:docs` |
| Run the complete release gate | `npm run test:all` |
| Test the wide browser layout | `npm run test:wide` |
| Test the mobile client | `npm run test:mobile` |

Running `npm start` with no subcommand uses the configured host and port. The
`index` command skips an unchanged source that is already `ready`; `--force`
replaces its Index. The `serve --host` and `serve --port` options override the
configured defaults. `--reload` is accepted for command-line compatibility but
currently has no effect.

## Configuration

These settings apply to the Node/Fastify/SQLite server and its CLI. The browser
PWA uses its browser IndexedDB Mobile Library instead of these filesystem settings.
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

The following file and Index operations describe the server and CLI path. The
browser PWA stores retained sources in browser IndexedDB and uses **Remove
source** to remove a retained source.

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

The browser app is a separately compiled static mobile build. The Node runtime
provides the local server, API, and CLI. Run the checks with:

```bash
npm run check:docs
npm run build
npm run typecheck
npm test
npm run test:contracts
npx playwright install chromium
npx playwright install webkit
npm run test:wide
npm run test:mobile
npm run test:all
```

The wide browser check uses Playwright Desktop Chromium. The mobile checks use
emulated Pixel 7 Chromium and iPhone 13 WebKit. Run `npx playwright install
webkit` once for the WebKit project when needed. These are browser emulations,
not physical Android or iOS hardware. `npm run test:all` runs type checking,
contract tests, TypeScript tests, the wide PWA check, and both mobile browser
projects. The browser tests start isolated servers and do not use the default
`data/` Index.

The production Scan benchmark can be run with:

```bash
npm run benchmark -- --games 1000000
```

See [docs/DESIGN.md](docs/DESIGN.md) for the architecture record and
[docs/VALIDATION.md](docs/VALIDATION.md) for the validation report. The main
source areas are:

```
mobile/               Sole static browser client and generated build
mobile/pieces/        Local CBurnett SVG chess pieces
src/mobile/           Persistent Mobile Library and browser Scan worker
src/server.ts        Fastify routes and static hosting
src/library.ts       Library intake and Scan lifecycle
src/scan-worker.ts   Background Scan worker adapter
src/index.ts         Index persistence, replacement, reset, and status
src/source.ts        Source fingerprints and bounded source-byte spans
src/projection.ts    Index/GameDocument response projection and errors
src/scan.ts          Platform-neutral streaming game-boundary scanner
src/scanner.ts       Filesystem-facing scanner adapter
src/main.ts          TypeScript CLI entry point
src/hydration.ts     Per-game hydration through chess.js
src/database.ts      SQLite schema and connection lifecycle
tests/               Shared PGN sources and contract fixtures
tests-ts/            TypeScript behavior and integration tests
tests/mobile/        Mobile Playwright tests
scripts/check-docs.mjs Documentation consistency checker
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
default set, vendored locally in `mobile/pieces/`. It is licensed under
GPLv2+ and is also available under BSD/GFDL. Source:
<https://github.com/lichess-org/lila/tree/master/public/piece/cburnett>
