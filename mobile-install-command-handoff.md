# Mobile Install Command Handoff

## Goal

Give a developer one workspace-local command that builds a web app, exposes its production preview through a Cloudflare Quick Tunnel, and prints the HTTPS URL for opening the app on a phone. Provide a second command that stops the preview and tunnel.

The command automates serving the app. The phone user still installs it from the mobile browser's **Install app** or **Add to Home Screen** menu.

## Command Contract

Use a repo-local executable so no global package or shell setup is required:

```sh
./<project-command> --install-mobile
./<project-command> --shutdown
```

For this repository, the command is `./offline-pgn-reader`. The source project
uses `./offline-blindchess`.

On a fresh start, run these commands in the repository root and in order:

```sh
npm install
npm run build
PGNREADER_MOBILE_PORT=8431 npm run serve:mobile
cloudflared tunnel --url http://127.0.0.1:8431
```

Check that `cloudflared` is installed before doing the install/build work. It remains a separately installed prerequisite. The implemented workflow targets macOS and Linux.

Wait for the preview server to be ready, then wait for cloudflared to print its `https://*.trycloudflare.com` URL. Print that URL and return control to the shell while the preview and tunnel continue running in the background. Cloudflare may take a short time to route requests to the new URL. Redirect child output to per-session logs so background processes do not depend on the launcher's terminal.

## Lifecycle Rules

- Keep one managed session per workspace. A repeated start reuses the existing URL only when both managed process groups are alive and the local preview and public URL serve the expected app.
- If a saved session is stale or only partially alive, stop its remaining managed processes, remove its state, and start cleanly.
- If startup fails after one or both background processes launch, stop the partial session and report the error and log location.
- `--shutdown` stops only processes launched by this command. With no active session, it succeeds with a clear no-op message.
- On shutdown, send `SIGTERM` to the managed process groups; after a short grace period, use `SIGKILL` if needed.
- Remove active state on shutdown and retain the last session's logs until the next fresh start.
- Do not kill an arbitrary process just because it listens on the selected mobile port. The default is `8431`; if the selected port is occupied, fail without tunneling to that listener.
- Treat a Quick Tunnel URL as temporary and public to anyone who knows it. A fresh tunnel can have a different origin; a phone installation tied to the old URL must be installed again.

## Implementation Notes

- Resolve the project root from the executable's own location so the command does not rely on the caller's current directory.
- Store session state and logs in the ignored workspace directory `.offline-pgn-reader/`. Write state atomically so an interrupted write does not leave invalid JSON.
- Track process-group IDs and process start times. Before signaling, confirm that the group still contains the expected preview or cloudflared command and that its leader has not been replaced by a reused PID.
- Start preview and tunnel in detached process groups with their output redirected to log files. This lets the command exit without closing its children.
- Confirm preview readiness using the managed `serve:mobile` process and its `Mobile PWA static server listening` startup line, then verify that the response contains the `PGN Reader Mobile` title and `PGN sources` heading. A matching page title alone is insufficient: an unrelated listener could serve the same page.
- Parse the URL from cloudflared's combined stdout/stderr log. Set a startup timeout; if no URL arrives or cloudflared exits, clean up the preview too.
- Keep app-specific pieces configurable when adapting this to another repo: command name, build script, preview command, port, host-header, readiness evidence, HTML marker, and Vite `allowedHosts` settings.

## Documentation And Tests

Document the one-time `cloudflared` prerequisite, both commands, the manual phone-browser installation step, background lifetime, shutdown, and temporary/public URL behavior.

Test the CLI boundary with isolated fake `npm` and `cloudflared` executables plus a real local HTTP listener. Cover:

- Start prints the tunnel URL and leaves preview/tunnel alive after the launcher exits.
- Repeated start returns the same URL without starting another session.
- Shutdown stops both managed processes and is safe to repeat.
- A port conflict fails and does not stop or tunnel an unrelated listener, including one that returns the expected app title.
- Partial startup failure cleans up any process already launched.

Also run the repo's full test suite and production build. A live smoke test should confirm the printed HTTPS URL serves the built app, then run shutdown and verify both managed processes are gone.

## Source Reference

The source repo already contains an implementation and tests. Use these as the concrete reference and adapt project-specific paths and checks:

- `offline-blindchess`: executable entry point
- `scripts/mobile-tunnel.mjs`: lifecycle and process management
- `scripts/mobile-tunnel.test.mjs`: CLI integration tests
- `README.md`: user-facing setup and behavior
- `.gitignore`: ignored runtime state directory

Verified in the source repo: 45 tests passed, production build passed, the real Quick Tunnel returned HTTP 200, repeat start reused its URL, shutdown stopped the server and tunnel, and the occupied-port scenario preserved the unrelated listener.

## Suggested Skills

- `/grill-with-docs` to adapt any product or lifecycle decisions for the target repo.
- `/implement` and `/tdd` to build the command and test its public behavior.
- `/domain-modeling` if the target repo needs new project vocabulary.
- `/code-review` to review the resulting diff against the agreed requirements and local standards.
