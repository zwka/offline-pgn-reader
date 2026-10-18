---
name: verify
description: Drive Offline PGN Reader's local browser PWA through real import, search, reader, persistence, and offline workflows, then capture Playwright evidence.
---

# Verify Offline PGN Reader

Use this skill to verify the browser PWA through its real user workflows. Read [the feature map](features/README.md) before choosing a journey.

## Launch

Run verification from the repository root with Node.js `>=22.14.0 <27` and npm `>=11 <12`. The mobile Playwright config builds the PWA, then runs `npm run serve:mobile` on `127.0.0.1:8763` by default. The TypeScript Fastify server serves only the static `mobile/` directory. It does not register the application API or open SQLite. Playwright refuses to reuse an existing server and tears down the server when the test run exits.

Install the Chromium browser once with `npx playwright install chromium` before the first run. Install WebKit with `npx playwright install webkit` when running the `ios-webkit` project.

Start a run-specific evidence directory and launch the app with its read-only doctor check:

```bash
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
VERIFY_DIR=".artifacts/verify/$RUN_ID"
mkdir -p "$VERIFY_DIR"
npm run test:mobile -- --project=android-chromium --grep "publishes install metadata and precaches the complete mobile build" --output "$VERIFY_DIR/doctor" --trace on --workers=1
```

The doctor test is the launch command. It loads the PWA in a fresh browser context, waits until the service worker controls the page, and checks the empty Library UI, manifest, and precached app assets. No seed data, sign-in, Node API, or server database is required. The test context owns its cache and is discarded after the run.

Set `PGNREADER_MOBILE_TEST_PORT` to a free port before running a command when port `8763` is occupied. The Playwright config passes that value to `serve:mobile` as `PGNREADER_MOBILE_PORT`. The test runner must start its own server. Do not drive a server started outside the test run.

## Doctor

The launch command above is the read-only app-data check. A passing run verifies the empty Library controls, install metadata, and service-worker cache from [pwa.spec.ts](../../../tests/mobile/pwa.spec.ts). The runner owns the test server because the Playwright config sets `reuseExistingServer: false`. The PWA has no authentication. If this check fails, inspect its test output and trace before trusting a feature result.

## Drive

Use the exact test command in the selected feature file. Each command starts a fresh browser context and app server. The test drives the same file picker, search field, source controls, and Reader controls used by the browser UI. Playwright's `setInputFiles` supplies a local PGN through the file input; it does not call a test-only app endpoint.

The map covers the primary user surface, the installable browser PWA. The local Fastify API and CLI are secondary surfaces. Use `npm test` for their unit and integration coverage, and `npm run test:wide` for the PWA served by Fastify at a wide viewport.

## Evidence

Keep `VERIFY_DIR` in the same shell session and pass a distinct child directory as `--output` for each journey. Use `--trace on` so successful runs retain a Playwright trace with the action timeline, screenshots, and DOM snapshots. The test output records the assertions for each user action.

Verify persistence through a user-visible reload or offline restart, and verify game state through the visible record list, Reader, notation, or board. Do not treat a final screenshot alone as proof. Preserve traces and logs under `.artifacts/verify/$RUN_ID/`; `.artifacts/` is ignored by Git.

## Cleanup

The Playwright runner closes its browser context and the server it started when the command exits. It keeps trace artifacts in the selected output directory. Do not remove `.artifacts/verify/$RUN_ID/` during cleanup. If a run is interrupted, stop the exact Playwright command you started, then check its configured port before retrying. Do not kill a process by name.

## Helpers

The existing Playwright CLI and test files are the driver. No helper script is required.
