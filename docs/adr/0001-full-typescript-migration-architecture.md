---
status: accepted
---

# Full TypeScript Migration Architecture

The application will replace the Python runtime and browser JavaScript with one npm-managed Node.js and TypeScript application, while keeping the single-process localhost experience and the existing SQLite library readable. The migration is behavior-first and incremental: its required deep modules are the external wire model, PGN source scanner, GameDocument hydration, index persistence, scan coordination, and reader projection; Python remains a test-only oracle until the shared parity gate passes.

## Considered Options

- Keep the Python backend and migrate only the browser: rejected because the goal is a full implementation migration.
- Perform a big-bang rewrite: rejected because scanner, hydration, persistence, and wire behavior have high compatibility risk.
- Use a frontend framework or a package-level monorepo: rejected for this migration because the current vanilla reader and single-context repository do not require either change.

## Consequences

- Node.js LTS, Fastify, TypeBox/JSON Schema, better-sqlite3, worker threads, Vite, Vitest, and Playwright become part of the application toolchain.
- Existing HTTP routes, wire casing, SQLite schema version 1, source-byte offsets, ordered tag pairs, and flat GameDocument node IDs remain compatibility contracts.
- Python and TypeScript use separate fixture databases during comparison; Python is removed only after parity, browser, and integration checks pass.
