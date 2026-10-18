# Read and navigate a Game

The Reader displays a Game record on a chessboard with notation, comments, Variations, game tags, raw source text, and navigation between adjacent records.

## Sub-features

- `reader-open` opens a selected Game record in the Reader.
- `reader-moves` follows notation and board state through a game.
- `reader-variations` enters an alternate continuation.
- `reader-annotations` shows comments, move marks, arrows, and highlighted squares.
- `reader-neighbors` opens the previous or next Game record.
- `reader-source` displays the original PGN text for the selected record.

## How to get to it (user POV)

- Import a PGN source with `Choose PGN source`.
- Choose a Game record in the `Game records` list.
- Use the notation, Reader controls, or an alternate Variation to navigate.
- Choose `Raw PGN source` to inspect the selected record's source text.
- Choose `Back to Game records` to return to the list.

## Driving it with Playwright

Preconditions:

- The `android-chromium` Playwright project is available.
- The test imports annotation, graphics, Variation, FEN, and malformed-record fixtures into a fresh browser context.

- **Open a Game record.** Run `npm run test:mobile -- --project=android-chromium --grep "opens Game records in the local reader with annotations, FEN starts, and neighbors" --output "$VERIFY_DIR/reader" --trace on --workers=1`. The test selects `.game-record`; `#reader-panel` appears and `.reader-title` reads `Annotator`.
- **Follow notation.** Click a move in `.notation-body .mv` or use `[data-action="forward"]`, `[data-action="back"]`, `[data-action="start"]`, and `[data-action="end"]`. Check `.notation-body .mv.current` and the corresponding `.board .sq[data-square="..."] .piece` state.
- **Inspect annotations and Variations.** The test checks the comment and move marks, board arrows and highlighted squares, then selects a move under `.variation .mv` and checks the current notation and board.
- **Open adjacent records and source.** Use `[data-action="next-game"]` and `[data-action="previous-game"]`, then choose the `Raw PGN source` button. The Reader title and source text identify the selected record.

## Gotchas

- The test fixture includes an invalid FEN record. The Reader should show its warning while keeping neighboring Game records available.
- Check board state after a move action. A visible notation string alone does not prove that the board followed it.
- The `android-chromium` project uses an emulated mobile viewport. Use `npm run test:wide` for the wide PWA layout.
