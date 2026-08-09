# Validation Report — v1.1.0 (2026-08-09)

The final gate is `npm run test:all`: TypeScript type checking, Vitest,
TypeScript behavior contracts, and Playwright browser tests. TypeScript is the
sole runtime and verification authority. The contract suite uses the shared PGN
source fixtures and checks the observable behavior of the Index, SQLite schema,
HTTP wire responses, source spans, ordered Tag pairs, and GameDocument payloads.

## Validation Areas

| # | Area | Failure modes | Tested by | Result |
|---|---|---|---|---|
| 1 | PGN header extraction | escaped quotes, non-roster tags, tag order loss | `tests-ts/scanner.test.ts`, `tests-ts/games.test.ts` | TypeScript tests preserve ordered Tag pairs and extras |
| 2 | Game boundary detection | fake tags inside comments, headers-only games, tagless movetext | `tests-ts/scanner.test.ts` | TypeScript scanner tests cover brace state, headers-only records, and warnings |
| 3 | Large-file indexing | memory blow-up, quadratic scans | `tests-ts/scanner.test.ts`, `tests-ts/benchmark.test.ts`, `docs/benchmarks/typescript-scan.md` | One-pass scanner and repeatable production benchmark |
| 4 | Offset-based retrieval | stale offsets after edits, span corruption, read races | `tests-ts/games.test.ts`, `tests-ts/source.test.ts`, `tests-ts/source-race.test.ts`, `tests-ts/scan.test.ts` | Fingerprints and bounded span checks protect source reads |
| 5 | SAN parsing | illegal moves, nonstandard move numbers | `tests-ts/hydration.test.ts`, `tests-ts/games.test.ts` | Legal prefixes remain readable and warnings are retained |
| 6 | Comment preservation | multi-line comments, semicolon comments | `tests-ts/hydration.test.ts`, `tests-ts/games.test.ts` | Parsed comments and indexed source text remain available |
| 7 | NAG preservation | suffix and numeric forms, multiple NAGs | `tests-ts/hydration.test.ts` | Numeric NAGs and display glyphs are retained |
| 8 | Variation tree | nesting, sibling order, starting comments | `tests-ts/hydration.test.ts`, `tests-ts/games.test.ts` | Flat nodes preserve explicit parent and child relationships |
| 9 | FEN/SetUp | invalid FEN, mid-game ply and move numbers | `tests-ts/hydration.test.ts` | Starting positions and warnings are covered |
| 10 | Malformed PGN tolerance | garbage tokens, broken records | `tests-ts/hydration.test.ts`, `tests-ts/scan.test.ts` | Neighboring records remain readable and warnings are surfaced |
| 11 | File re-scan | missed changes, failed replacement, interrupted scans | `tests-ts/index.test.ts`, `tests-ts/scan.test.ts`, `tests-ts/scan-lifecycle.test.ts`, `tests-ts/cli.test.ts` | Fingerprint, replacement, retry, and lifecycle protections are covered |
| 12 | Browser compatibility | local assets, source intake, reader workflows | `tests/browser/smoke.spec.ts` | Playwright covers Library, game list, reader, source, graphics, variations, removal, and reset |
| 13 | Notation rendering | variation context loss, comment blobs, large trees | `tests/browser/smoke.spec.ts`, `frontend/notation.js` | Reader rendering and chunked large-document updates are covered |
| 14 | Navigation correctness | wrong sibling cycling, dead ends | `tests/browser/smoke.spec.ts`, `tests/fixtures/variations.pgn` | Keyboard navigation follows the GameDocument tree |
| 15 | Startup and shutdown | port conflicts, schema drift, dirty WAL | `tests-ts/health.test.ts`, `tests-ts/cli.test.ts`, `tests-ts/scan-lifecycle.test.ts`, `src/database.ts` | Health, schema, worker cleanup, reset, and recovery behavior are covered |

## Behavior Contracts

| Area | Check | Result |
|---|---|---|
| PGN source and Scan | `npm run test:contracts` | `contract_manifest.json` sources are scanned and checked through the HTTP and Index layers |
| SQLite Index | `tests-ts/contracts.test.ts` | Schema version 1, table columns, indexed fields, and source counts are checked |
| HTTP compatibility | `wire_contract.json` and `error_contract.json` | Health, route errors, wire casing, and error envelopes are checked |
| Full gate | `npm run test:all` | Typecheck, Vitest, behavior contracts, and Playwright run together |
| Production process | `npm start` / `src/main.ts` | Node.js/TypeScript is the sole production process |

## Honest Gaps

- An unterminated `{` can swallow following games into one record. The 8 MiB
  hydration span cap refuses an unsafe read without modifying the PGN source.
- Multiple consecutive brace comments merge into one comment node.
- `%` escape lines survive in raw source only, not in the parsed model.
- LIKE-based search is the upgrade path to FTS5 for very large indexes.
- The reader is Chessable-like but does not include move training, spaced
  repetition, or per-chapter progress tracking.
