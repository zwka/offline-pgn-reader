# Production TypeScript Scan Benchmark

This benchmark measures the production TypeScript `Scan` path independently of
the historical Python reference benchmark. It generates a representative large
PGN source at run time, so no large fixture is stored in the repository.

## Run

From the repository root:

```bash
npm run benchmark -- --games 1000000
```

The default is 1,000,000 game records. The source and isolated SQLite `Index`
are created under an ignored `.benchmark-scan-*` directory in the checkout and
are removed when the command exits by default. Use `--keep` only when
investigating a failed run. `--json` emits the measurement as one JSON object
for automation.

## Method

- The source contains fixed-width, 1-0 game records with six headers and a
  short movetext line. Each record is generated in batches and written to disk;
  the source is never held as one in-memory string.
- A child Node process registers the source in a fresh SQLite `Index` and calls
  `LibraryService.scanFileSync`, the same synchronous production path used by
  the `index` CLI command. The benchmark wall clock starts immediately before
  that call and stops after it returns.
- Peak memory is the child process maximum resident set size from
  `process.resourceUsage().maxRSS`. On macOS, the POSIX value is converted from
  KiB to bytes. It includes Node and SQLite startup, which is stated explicitly
  rather than presenting scanner-only heap usage as process memory.
- Verification walks every resulting `Index` row and checks its expected game
  fields, sequential index, and exact byte offsets. The first, middle, and last
  spans are also read back from the source bytes and compared byte-for-byte.

## Measured Result

Run date: 2026-08-09

Conditions:

- macOS 26.5.2 arm64 on a MacBookAir10,1
- Node.js `v26.7.0`, npm `11.19.0`
- package engine range: Node.js `>=22.14.0 <27`
- generated source: 1,000,000 games, 164 bytes per record
- isolated SQLite `Index`; source generation and verification are outside the
  reported production scan wall clock

Command:

```bash
npm run benchmark -- --games 1000000
```

Measured output:

```text
TypeScript production Scan benchmark
source: generated PGN, 1,000,000 games, 164 bytes/game, 156.4 MiB
Library data: isolated temporary SQLite Index
wall-clock time: 12.064 s
peak RSS: 147.6 MiB
scanned game count: 1,000,000
source-offset correctness: PASS (1,000,000/1,000,000 Index rows)
Index records: PASS (1,000,000/1,000,000 expected records)
source-byte spans: PASS (3/3 sampled first/middle/last spans)
throughput: 13.0 MiB/s, 82,892 games/s
temporary data: removed
```

The pre-cutover Python reference result remains recorded separately in
`CHANGELOG.md` and `docs/VALIDATION.md`; it is not a TypeScript production
measurement and should not be treated as a direct apples-to-apples comparison.
