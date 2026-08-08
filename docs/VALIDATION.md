# Validation Report — v1.1.0 (2026-08-08)

Every subsystem below lists: failure modes considered, how it is tested,
the observed result, and remediation if it fails in the field.

The Python suite remains the rollback oracle. The TypeScript suite owns
production behavior; the cross-runtime parity test uses the same ten source
fixtures and separate SQLite databases for both implementations.

| # | Area | Failure modes | Tested by | Result | Remediation |
|---|------|---------------|-----------|--------|-------------|
| 1 | PGN header extraction | escaped quotes, non-roster tags, tag order loss | `test_scanner.py::test_two_games_boundaries_and_headers`, `test_parser.py::test_headers_preserved_in_order` | ✅ order + extras preserved; `tag_json` keeps duplicates | headers re-readable from raw span at any time |
| 2 | Game boundary detection | `[` at line start inside multi-line `{}` comment; headers-only games; tagless movetext | `test_multiline_comment_with_fake_tag_is_not_a_boundary`, `test_headers_only_game_detected`, `test_movetext_without_tags_flagged` | ✅ brace state tracked across lines; 185/351 exact counts on real samples | re-scan with force; worst case = merged record flagged at hydration by size cap |
| 3 | Large-file indexing | memory blow-up, quadratic scans | benchmark: 231 MB / 1M games | ✅ 19.5 s, 38 MB peak RSS (constant) | progress reporting shows stalls; scans are resumable by re-run |
| 4 | Offset-based retrieval | stale offsets after file edit, span corruption | `test_get_game_document_by_offset`, `test_samples_source_round_trip`, stale-flag tests | ✅ byte-exact spans; fingerprint marks file stale in UI | stale badge + one-click re-scan; hydration errors → HTTP 422 with message |
| 5 | SAN parsing | illegal moves, nonstandard move numbers (`1. c6` for Black) | full hydration sweep over all 536 sample games; `test_banzea_intro_prose_preserved` | ✅ 0 warnings across samples | illegal moves skipped with warning; legal prefix kept |
| 6 | Comment preservation | multi-line comments, semicolon comments dropped by python-chess | `test_brace_comments_and_pregame_comment`, `test_semicolon_comment_preserved` | ✅ `;` comments promoted to brace comments pre-parse | raw source endpoint always byte-exact |
| 7 | NAG preservation | suffix (`!?`) vs numeric (`$5`) forms, multiple NAGs per move | `test_nags_suffix_and_numeric`, sample spot check (`17.h4 $6`) | ✅ both forms; glyph map with `$n` fallback for unknown | unknown NAGs still stored numerically |
| 8 | Variation tree | nesting, sibling order, starting comments | `test_variation_tree_structure`, `test_kabadayi_annotation_fidelity` (3-way branch with `{h5}` starting comment) | ✅ explicit tree, exact source order | normalized re-export test proves tree shape survives round-trip |
| 9 | FEN/SetUp | invalid FEN, mid-game ply/move numbers | `test_fen_setup_start_position`, `test_invalid_fen_degrades_with_warning` | ✅ move 17 starts render as move 17; invalid FEN → standard start + warning | warning surfaces in reader UI |
| 10 | Malformed PGN tolerance | garbage tokens silently vanishing, broken game killing file | `test_malformed_game_does_not_break_neighbors`, `test_malformed_movetext_keeps_prefix_and_warns` | ✅ neighbors intact; unrecognized tokens reported as warnings | per-game warnings in list + reader; scan never aborts |
| 11 | File re-scan | unchanged files re-scanned wastefully; changes missed | `test_unchanged_file_skips_rescan`, `test_changed_file_marked_stale_and_rescan_updates` | ✅ fingerprint (size+mtime+head/tail SHA-1) gates scans | `--force` / UI Re-scan override |
| 12 | Browser compatibility (Brave) | Chromium rendering, no external assets | manual smoke in Chromium preview: library, table, reader, keyboard nav, variation cycling | ✅ zero console errors; no network beyond localhost | vanilla JS + standard CSS only, no CDN |
| 13 | Notation rendering | variation context loss, comment blobs, huge trees freezing tab | browser verification against known source text; chunked rendering ≥1500 nodes/frame | ✅ sidelines indented/collapsible; source text matched rendering | progressive render caps main-thread work per frame |
| 14 | Navigation correctness | wrong sibling cycling, dead ends | browser test: `g5 → h4?! → g5` cycle over a real 3-way branch; `End`/`Home` | ✅ matches document tree exactly | keyboard map documented in help overlay |
| 15 | Startup/shutdown | port conflicts, schema drift, dirty WAL | `npm start`, `test_health`, schema-version rebuild logic in `database.initialize()` | ✅ Node health endpoint reports db state; version mismatch rebuilds cache | `npm start -- reset`; Python reset remains rollback-only |

## Debugging pass findings (fixed during review)

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
   root; hydration uses a single incrementally pushed/popped board instead.

## TypeScript cutover validation

| Area | Check | Result |
|---|---|---|
| Cross-runtime PGN parity | `npm run test:parity` | ✅ Fastify and FastAPI compare the same scan records, source spans, ordered headers, flat nodes, comments, NAGs, FEN positions, graphics, malformed warnings, and duplicate Tag pairs |
| SQLite parity | parity snapshot | ✅ separate databases expose schema version 1, matching table columns, indexed fields, byte offsets, tag JSON pairs, and scan state |
| HTTP compatibility | parity snapshot + `wire_contract.json` + `error_contract.json` | ✅ health, existing routes, camelCase/snake_case wire casing, source text, Tag endpoint, and error envelopes match |
| Full gate | `npm run test:all` | ✅ typecheck, Vitest, Python oracle, parity, and Playwright run in one command |
| Production process | `npm start` / `src/main.ts` | ✅ Node.js/TypeScript starts the production server; Python remains documented as rollback-only until release acceptance |

## Honest gaps (not fixed in v1)

- Unterminated `{` swallows following games into one record (mitigated by
  8 MiB span cap → clear error, and the raw file is never damaged).
- Multiple consecutive brace comments merge into one comment node.
- `%`-escape lines survive in raw source only, not in the parsed model.
- LIKE-based search is ~1.5 s at 1M games (FTS5 is the upgrade path).
- "Chessable-like" approximations: no move trainer/spaced repetition and no
  per-chapter progress tracking. Reading flow, variation handling, keyboard
  study navigation, and `[%cal]`/`[%csl]` board graphics are implemented
  (since v1.1.0; arrows are straight lines, and shapes in variation starting
  comments display on the node's post-move position).
