# Validation Report — v1.1.0 (2026-08-08)

Every subsystem below lists: failure modes considered, how it is tested,
the observed result, and remediation if it fails in the field. The final gate is
`npm run test:all`: TypeScript type checking and Vitest, the Python oracle,
cross-runtime parity, and Playwright browser tests.

The Python suite remains the rollback oracle. The TypeScript suite owns
production behavior; the cross-runtime parity test uses the same ten source
fixtures and separate SQLite databases for both implementations.

Audit run on 2026-08-08: `npm run typecheck` passed; `npm test` passed 10 test
files / 58 tests; `npm run test:python` passed 75 tests; `npm run test:parity`
passed 1 parity test; and `npm run test:browser` passed 10 Playwright tests.
`npm run test:all` repeated the full gate successfully. The Python run emitted
two dependency deprecation warnings, with no test failures.

| # | Area | Failure modes | Tested by | Result | Remediation |
|---|------|---------------|-----------|--------|-------------|
| 1 | PGN header extraction | escaped quotes, non-roster tags, tag order loss | `tests-ts/scanner.test.ts`, `tests-ts/games.test.ts`, `tests/test_scanner.py::test_two_games_boundaries_and_headers`, `tests/test_parser.py::test_headers_preserved_in_order` | ✅ order + extras preserved; `tag_json`, `headers`, and `/tags` keep duplicates | source headers remain re-readable from the indexed span |
| 2 | Game boundary detection | `[` at line start inside multi-line `{}` comment; headers-only games; tagless movetext | `tests-ts/scanner.test.ts`, `tests/test_scanner.py::test_multiline_comment_with_fake_tag_is_not_a_boundary`, `tests/test_scanner.py::test_headers_only_game_detected`, `tests/test_scanner.py::test_movetext_without_tags_flagged` | ✅ brace state tracked across lines; 185/351 exact counts on real samples | force re-scan; an unterminated comment may merge records and is bounded at hydration |
| 3 | Large-file indexing | memory blow-up, quadratic scans | streaming scanner tests plus the recorded pre-cutover 231 MB / 1M-game reference benchmark | ✅ scanner is one-pass and bounded; the 19.5 s / 38 MB result is the existing Python reference benchmark | progress reports bytes and games; a failed scan can be retried from the source |
| 4 | Offset-based retrieval | stale offsets after file edit, span corruption | `tests-ts/games.test.ts`, `tests-ts/scan.test.ts`, `tests/test_service.py::test_get_game_document_by_offset`, `tests/test_samples.py::test_samples_source_round_trip` | ✅ indexed spans are byte-addressed; fingerprint marks a file stale and reads reject changed sources | stale badge + re-scan; PGN hydration failures return HTTP 422 |
| 5 | SAN parsing | illegal moves, nonstandard move numbers (`1. c6` for Black) | TypeScript hydration fixtures plus Python full hydration sweep over all 536 sample games; `tests/test_samples.py::test_banzea_intro_prose_preserved` | ✅ 0 warnings across the tracked samples | illegal moves are reported and the legal prefix is retained |
| 6 | Comment preservation | multi-line comments, semicolon comments dropped by parser libraries | `tests-ts/hydration.test.ts`, `tests/test_parser.py::test_brace_comments_and_pregame_comment`, `tests/test_parser.py::test_semicolon_comment_preserved` | ✅ `;` comments are folded into parser comments while source text remains unchanged | source endpoint returns the indexed span as decoded text; source bytes are not rewritten |
| 7 | NAG preservation | suffix (`!?`) vs numeric (`$5`) forms, multiple NAGs per move | `tests-ts/hydration.test.ts`, `tests/test_parser.py::test_nags_suffix_and_numeric`, sample spot check (`17.h4 $6`) | ✅ both forms; glyph map with `$n` fallback for unknown | unknown NAGs still stored numerically |
| 8 | Variation tree | nesting, sibling order, starting comments | `tests-ts/hydration.test.ts`, `tests/test_parser.py::test_variation_tree_structure`, `tests/test_samples.py::test_kabadayi_annotation_fidelity` | ✅ explicit flat tree, exact source order | normalized fixture re-parse proves tree shape survives |
| 9 | FEN/SetUp | invalid FEN, mid-game ply/move numbers | `tests-ts/hydration.test.ts`, `tests/test_parser.py::test_fen_setup_start_position`, `tests/test_parser.py::test_invalid_fen_degrades_with_warning` | ✅ FEN-start move numbers render correctly; invalid FEN → standard start + warning | warning surfaces in reader UI |
| 10 | Malformed PGN tolerance | garbage tokens silently vanishing, broken game killing file | `tests-ts/hydration.test.ts`, `tests-ts/scan.test.ts`, `tests/test_scanner.py::test_malformed_game_does_not_break_neighbors`, `tests/test_parser.py::test_malformed_movetext_keeps_prefix_and_warns` | ✅ neighbors intact; unrecognized tokens reported as warnings | per-game warnings in list + reader; malformed records do not abort a scan |
| 11 | File re-scan | unchanged files re-scanned wastefully; changes missed; replacement failure loses the prior index | `tests-ts/scan.test.ts`, `tests-ts/cli.test.ts`, `tests/browser/smoke.spec.ts`, `tests/test_service.py::test_unchanged_file_skips_rescan`, `tests/test_service.py::test_changed_file_marked_stale_and_rescan_updates` | ✅ fingerprint (size+mtime+sampled SHA-1) gates scans; failed replacement rolls back game rows | `--force` / UI Re-scan override; retry after restart from `pending` |
| 12 | Browser compatibility | Chromium rendering, local assets, source intake and Library actions | `tests/browser/smoke.spec.ts` under `playwright.config.ts` with an isolated Node server | ✅ Playwright covers the Library, Game list, reader, tags/source, graphics, variations, stale re-scan, removal, and reset flows | keep browser assets local; the app has no CDN/runtime network dependency |
| 13 | Notation rendering | variation context loss, comment blobs, huge trees freezing tab | `tests/browser/smoke.spec.ts`, `frontend/notation.js` chunking at 1,500 nodes | ✅ sidelines are indented/collapsible, comments are prose blocks, and source text is separately available | progressive rendering yields between chunks |
| 14 | Navigation correctness | wrong sibling cycling, dead ends | browser test cycles `e5` / `c5` in `tests/fixtures/variations.pgn` with ArrowUp/ArrowDown; reader controls cover Home/End and adjacent games | ✅ sibling order and FEN-backed board positions match the document tree | keyboard map remains documented in the help overlay |
| 15 | Startup/shutdown | port conflicts, schema drift, dirty WAL | `npm start`, `tests-ts/health.test.ts`, `tests-ts/cli.test.ts`, schema-version logic in `src/database.ts` | ✅ Node health endpoint reports db state; worker cleanup and reset protections are covered | use `npm start -- reset`; Python reset remains rollback-only and must use isolated data |

## Debugging pass findings (Python oracle history; fixed during review)

1. **python-chess drops `;` comments** — found by `test_semicolon_comment_preserved`;
   fixed via pre-parse promotion to brace comments (`parser._promote_semicolon_comments`).
2. **Garbage movetext tokens vanish silently** — found by
   `test_malformed_movetext_keeps_prefix_and_warns`; fixed via token-coverage
   scan (`parser._find_unrecognized_tokens`), verified zero false positives
   across all 536 real sample games.
3. **Double-render of first-move variations** in the notation walker —
   caught in code review before it shipped; alternatives are now emitted only
   via the branch-point check.
4. **O(n²) trap avoided**: `node.board()` in python-chess replays from the
   root; the Python oracle uses a single incrementally pushed/popped board instead.

## TypeScript cutover validation

| Area | Check | Result |
|---|---|---|
| Cross-runtime PGN parity | `npm run test:parity` | ✅ Fastify and FastAPI compare the same ten-fixture scan records, source spans, ordered headers, flat nodes, comments, NAGs, FEN positions, graphics, malformed warnings, and duplicate Tag pairs |
| SQLite parity | parity snapshot in `tests-ts/parity.test.ts` | ✅ separate databases expose schema version 1, matching table columns, indexed fields, byte offsets, Tag-pair JSON, and scan state |
| HTTP compatibility | parity snapshot + `wire_contract.json` + `error_contract.json` | ✅ health, route errors, camelCase/snake_case wire casing, decoded source text, `/tags`, and error envelopes match |
| Full gate | `npm run test:all` | ✅ typecheck, Vitest, Python oracle, parity, and Playwright run in one command |
| Production process | `npm start` / `src/main.ts` | ✅ Node.js/TypeScript is the production server; Python is retained only for rollback and oracle validation |

## Honest gaps (not fixed in v1)

- Unterminated `{` swallows following games into one record (mitigated by an
  8 MiB hydration span cap; the read is refused rather than unbounded, and the
  raw file is never damaged).
- Multiple consecutive brace comments merge into one comment node.
- `%`-escape lines survive in raw source only, not in the parsed model.
- LIKE-based search is ~1.5 s at 1M games (FTS5 is the upgrade path).
- "Chessable-like" approximations: no move trainer/spaced repetition and no
  per-chapter progress tracking. Reading flow, variation handling, keyboard
  study navigation, and `[%cal]`/`[%csl]` board graphics are implemented
  (since v1.1.0; arrows are straight lines, and shapes in variation starting
  comments display on the node's post-move position).
