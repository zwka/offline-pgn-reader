# Use the PWA offline

After the PWA shell is cached and a PGN source is retained, the browser restores the Mobile Library and lets the user open Game records while network requests are blocked.

## Sub-features

- `offline-shell` installs and controls the page with the service worker.
- `offline-library` restores a retained PGN source after reload without network access.
- `offline-reader` opens a Game record and its source text while offline.
- `offline-variations` navigates comments, annotations, and Variations from retained data.

## How to get to it (user POV)

- Open the PWA once while the browser can load its shell and assets.
- Import a PGN source with `Choose PGN source` and wait for `ready`.
- Reload or reopen the PWA without a network connection.
- Choose a Game record and continue reading from the retained Mobile Library.

## Driving it with Playwright

Preconditions:

- The `android-chromium` Playwright project is available.
- The test starts with a fresh browser context and installs the service worker before blocking network requests.
- The test imports `offline-reader.pgn` through the browser file input; no fixture setup outside the PWA is required.

- **Restore the app offline.** Run `npm run test:mobile -- --project=android-chromium --grep "restores the persisted reader with network disabled" --output "$VERIFY_DIR/offline" --trace on --workers=1`. The test waits for `navigator.serviceWorker.ready`, reloads until the service worker controls the page, then disables network access.
- **Verify retained data.** After the offline reload, `#source-status` is `ready`, `#source-name` is `offline-reader.pgn`, and `#record-list .game-record` contains four records.
- **Read without network.** Open the first record. `.reader-title` contains `Annotator`, the initial board contains the white pawn at `e2`, and the notation shows the pre-game comment and move mark. Open `Raw PGN source` and verify the `Annotated` event text.
- **Check network and runtime errors.** The test requires no blocked requests and no uncaught page errors during the offline journey.

## Gotchas

- Wait for the service worker to control the page before disabling network. The test's readiness helper performs this sequence.
- The `ios-webkit` project uses a separate fallback for offline startup because Playwright WebKit cannot commit a navigation with network blocking. Run the mapped `android-chromium` command for the direct offline reload path.
- Playwright browser emulation does not prove installation or offline behavior on a physical phone.
