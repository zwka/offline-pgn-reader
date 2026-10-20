# Offline PGN Reader

## 1. Description

Offline PGN Reader is a browser-based chess study app. Import `.pgn` files to
search games and study their moves, comments, and variations on a chessboard.
The mobile PWA stores imported games in the browser and works offline after its
first load.

## 2. Prerequisites

- Node.js `24.11.1` and npm `11.x` (the repository supports Node.js
  `>=22.14.0 <27` and npm `>=11 <12`).
- A modern browser such as Chrome, Edge, Brave, or Safari.
- A `.pgn` file to import and study.
- Internet access to install npm packages and to load a deployed PWA for the
  first time. The PWA can work offline after that initial load.
- To use the one-command phone installer, `cloudflared` must be installed and
  available on `PATH`. That workflow supports macOS and Linux.

The repository includes `.nvmrc` for Node.js `24.11.1`. With nvm installed, use
`nvm install` and `nvm use` in the project directory. Otherwise, install a
supported Node.js and npm version directly.

## 3. Development Setup

1. Clone the repository and enter its directory:

   ```bash
   git clone https://github.com/zwka/offline-pgn-reader.git
   cd offline-pgn-reader
   ```

2. Install the project dependencies:

   ```bash
   npm ci
   ```

3. Type-check the project and build the browser app:

   ```bash
   npm run build
   ```

4. Start the local server for the browser app:

   ```bash
   PGNREADER_MOBILE_PORT=8431 npm run serve:mobile
   ```

5. Open <http://127.0.0.1:8431> in your browser and import a `.pgn` file.
   Press `Ctrl+C` in the terminal to stop the server.

For Node server and CLI development, run `npm run dev` in a separate terminal.
It starts the local API server; the browser PWA uses its own static server.

To run the full test suite, install the Playwright browsers and run the release
checks:

```bash
npx playwright install chromium webkit
npm run test:all
```

## 4. Production Setup

The production browser app is a static PWA. For a permanent deployment, build
and publish it as follows:

1. Install dependencies and build the production files:

   ```bash
   npm ci
   npm run build
   ```

2. Publish the complete generated `mobile/` directory to a static web host that
   serves the site over HTTPS.

3. Open the HTTPS address in a browser while online. Import `.pgn` files from
   that browser to store them in its local library. After the first load, the
   PWA and imported library are available offline in that browser.

For a quick phone install from macOS or Linux, install `cloudflared` first. On
macOS with Homebrew:

```bash
brew install cloudflared
```

On Linux, follow [Cloudflare's installation guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
Then run this command from the project directory:

```bash
./offline-pgn-reader --install-mobile
```

The command installs dependencies, builds the PWA, starts the static server and
temporary HTTPS tunnel in the background, then prints the phone URL. Open that
URL on the phone and choose **Install app** or **Add to Home Screen**. Anyone
with the temporary URL can access the PWA files; imported PGN files remain in
that browser's local storage.

Stop the server and tunnel with:

```bash
./offline-pgn-reader --shutdown
```

The Node server and CLI are separate from the browser PWA. Run `npm start` to
start the local API server; it does not serve the browser interface.
