# Offline PGN Reader verification map

This directory is the maintained map for the browser PWA's user-facing behavior. Read this index before running a journey, then use the matching feature recipe.

## Baseline preconditions

- Run commands from the repository root with Node.js `>=22.14.0 <27` and npm `>=11 <12`.
- Install the Chromium browser once with `npx playwright install chromium`. Install WebKit with `npx playwright install webkit` when running the `ios-webkit` project.
- The mobile Playwright config builds `mobile/dist/` and serves `mobile/` over HTTP for each test run.
- Each Playwright test gets a fresh browser context. The Mobile Library and service-worker cache do not share state across tests.
- The PWA has no sign-in, seed data, or dependency on the Node API. Feature tests import their own PGN data through the browser file input.
- Port `8763` is reserved for the mobile suite by default. Set `PGNREADER_MOBILE_TEST_PORT` to a free port for concurrent runs.
- The wide PWA test uses `PGNREADER_TEST_PORT` and a temporary server data directory. The API and CLI suites use `npm test`.
- Playwright projects use emulated Chromium and WebKit browsers. They are not physical Android or iOS devices.

## Driving conventions

- Start a run-specific evidence directory as described in [the verify skill](../SKILL.md).
- Run the exact Playwright command in the chosen feature file. Preserve `--trace on`, the feature-specific `--output` path, and the selected project.
- Prefer the accessible button names and stable IDs or `data-action` selectors recorded in the tests.
- Wait on Playwright expectations for statuses and rendered state. Do not replace them with fixed sleeps.
- Each test starts its own server with `reuseExistingServer: false`. Run tests sequentially when they use the default port.

## Proof and failure reporting

- A passing assertion proves the action and its resulting state. The trace records the action timeline, screenshots, and DOM snapshots.
- Persistence proof uses reload or offline startup and verifies the restored source or game through the UI.
- The PWA should not issue `/api/` requests. Tests that exercise this contract assert that the request list is empty.
- Keep traces and logs under `.artifacts/verify/$RUN_ID/`. Never delete the evidence during cleanup.
- Report the exact Playwright test name and unmet precondition for any failed or unreachable journey. Do not mark a feature verified through a different entry point.

## Features

- [Import and manage PGN sources](./sources.md) covers file import, source switching, retention across reload, duplicate names, and removal.
- [Search Game records](./search.md) covers metadata filtering and the 50-record page bound.
- [Read and navigate a Game](./reader.md) covers the board, notation, Variations, annotations, raw PGN, and adjacent games.
- [Use the PWA offline](./offline.md) covers service-worker readiness and restoring the Mobile Library and Reader without network access.
