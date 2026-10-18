# Import and manage PGN sources

The Mobile Library imports local PGN files, retains multiple sources in browser storage, switches the active source, and removes retained sources without changing the original files.

## Sub-features

- `source-import` scans a selected PGN file and shows its Game records.
- `source-retain` keeps imported sources across a page reload.
- `source-switch` changes the active source without opening a Game record.
- `source-remove` removes a retained source from the browser Mobile Library.
- `source-reject-duplicate` rejects a source name that differs only by letter case.

## How to get to it (user POV)

- Choose `Choose PGN source` and select a local `.pgn` file.
- Choose `Select <filename>` in the retained sources list to switch sources.
- Choose `Remove <filename>` to remove a retained source.

## Driving it with Playwright

Preconditions:

- The `android-chromium` Playwright project is available.
- The test uses a fresh browser context and creates its PGN contents itself.

- **Import sources.** Run `npm run test:mobile -- --project=android-chromium --grep "retains, orders, switches, removes, and restores Mobile Library sources" --output "$VERIFY_DIR/sources" --trace on --workers=1`. The test imports `zeta.pgn` and `Alpha.pgn` through `#source-input`. `#source-status` becomes `ready`, `Alpha.pgn` is active, and the source list is ordered `Alpha.pgn`, then `zeta.pgn`.
- **Reject duplicate name.** The test imports `ZETA.PGN`. `#source-error` reports that the name is already retained, while the active source and retained list remain unchanged.
- **Switch and restore.** Choose `Select zeta.pgn`, then reload. `#source-name` remains `zeta.pgn` and its Game record is visible.
- **Remove sources.** Choose `Remove Alpha.pgn` and `Remove zeta.pgn`. The active source returns to `No PGN source selected`, and the retained source list is empty.

## Gotchas

- The test's `setInputFiles` action exercises the browser file input. It does not copy either PGN into a server directory.
- IndexedDB state belongs to the test's browser origin and context. A fresh Playwright test starts with an empty Mobile Library.
- A `ready` status alone does not prove retention. The test reloads and checks the selected source and Game records again.
