---
status: superseded by ADR-0002
---

# Full TypeScript Migration Architecture

The application replaces the Python production runtime with an npm-managed Node.js and TypeScript server while retaining the vanilla browser JavaScript reader and the single-process localhost experience. It keeps the existing SQLite library readable. The migration is behavior-first and incremental: its required deep modules are the external wire model, PGN source scanner, GameDocument hydration, index persistence, scan coordination, and reader projection. Python remains the rollback runtime and compatibility oracle after the shared parity gate, while Node.js/TypeScript owns production behavior.

## Considered Options

- Keep the Python backend and migrate only the browser: rejected because the goal was a full runtime migration; the delivered reader intentionally remains vanilla browser JavaScript without a framework or build step.
- Perform a big-bang rewrite: rejected because scanner, hydration, persistence, and wire behavior have high compatibility risk.
- Use a frontend framework or a package-level monorepo: rejected for this migration because the current vanilla reader and single-context repository do not require either change.

## Consequences

- Node.js LTS, Fastify, TypeBox/JSON Schema, better-sqlite3, worker threads, Vitest, and Playwright become part of the application toolchain; the vanilla browser frontend remains build-free.
- Existing HTTP routes, wire casing, SQLite schema version 1, source-byte offsets, ordered tag pairs, and flat GameDocument node IDs remain compatibility contracts.
- Python and TypeScript use separate fixture databases during comparison. The parity, browser, and integration checks passed; Python is retained as the documented rollback runtime and compatibility oracle, while the production server and SQLite Index are owned by TypeScript.
