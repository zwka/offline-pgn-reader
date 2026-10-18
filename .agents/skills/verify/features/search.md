# Search Game records

Search filters the active source's Game records by metadata and keeps the list bounded when a source contains more than one page of records.

## Sub-features

- `search-metadata` filters records by player and opening metadata.
- `search-page-bound` limits the unfiltered list to 50 visible records per page.
- `search-summary` reports the visible range and total record count.

## How to get to it (user POV)

- Import a PGN source with `Choose PGN source`.
- Enter a player, event, site, date, ECO code, or opening in `Search metadata`.
- Use `Previous` and `Next` when the source has multiple pages.

## Driving it with Playwright

Preconditions:

- The `android-chromium` Playwright project is available.
- The test creates a PGN source with 101 Game records in a fresh browser context.

- **Check the page bound.** Run `npm run test:mobile -- --project=android-chromium --grep "keeps the main thread usable and bounds the searchable Game record list" --output "$VERIFY_DIR/search" --trace on --workers=1`. After importing `bounded.pgn`, `#record-list .game-record` contains 50 entries and `#list-summary` reads `1-50 of 101`.
- **Filter by metadata.** Fill `#metadata-search` with `Player 100`. One Game record remains, and `#record-list` contains both `Player 100` and `Opening 100`.

## Gotchas

- Search runs against the active browser Mobile Library, not the server-side SQLite Index.
- The test creates all 101 records in memory and imports them through the file input. It does not depend on a host library directory.
- Wait for the rendered record count and summary. Do not use a fixed delay.
