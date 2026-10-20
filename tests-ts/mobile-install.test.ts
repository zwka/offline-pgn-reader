import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    const commandPath = join(workspace, "offline-pgn-reader");
    if (existsSync(commandPath)) {
      runCommand(commandPath, ["--shutdown"], makeEnvironment(workspace, 8431));
    }
    rmSync(workspace, { force: true, recursive: true });
  }
});

describe("mobile install command", () => {
  it("prints a tunnel URL and leaves the PWA server running after the launcher exits", async () => {
    const workspace = createWorkspace();
    const port = await reservePort();
    const environment = makeEnvironment(workspace, port);

    const result = runCommand(
      join(workspace, "offline-pgn-reader"),
      ["--install-mobile"],
      environment,
    );

    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    expect(result.stdout).toContain("https://mobile-test.trycloudflare.com");

    const response = await fetch(`http://127.0.0.1:${port}/`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("<title>PGN Reader Mobile</title>");
    expect(html).toContain("id=\"import-title\">PGN sources</h1>");

    const events = readEvents(workspace);
    expect(events.map(({ executable, args }) => `${executable} ${args.join(" ")}`)).toEqual([
      "npm install",
      "npm run build",
      "npm run serve:mobile",
      `cloudflared tunnel --url http://127.0.0.1:${port}`,
    ]);
  });

  it("returns after cloudflared emits a URL even while the public route is unavailable", async () => {
    const workspace = createWorkspace();
    const port = await reservePort();
    const environment = {
      ...makeEnvironment(workspace, port),
      MOBILE_TEST_PUBLIC_UNAVAILABLE: "1",
    };
    const commandPath = join(workspace, "offline-pgn-reader");
    const launcher = spawn(commandPath, ["--install-mobile"], {
      cwd: tmpdir(),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    launcher.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    launcher.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const finished = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolveClose) => {
      launcher.once("close", (code, signal) => resolveClose({ code, signal }));
    });

    try {
      await waitForTunnelLog(workspace, launcher);
      const exit = await Promise.race([
        finished,
        delay(5_000).then(() => undefined),
      ]);

      expect(exit, stderr).toBeDefined();
      expect(exit?.code).toBe(0);
      expect(stdout).toContain("https://mobile-test.trycloudflare.com");
      expect(existsSync(join(workspace, "tunnel-fetches.jsonl"))).toBe(false);
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    } finally {
      if (launcher.exitCode === null) {
        launcher.kill("SIGTERM");
        await finished;
      }
      runCommand(commandPath, ["--shutdown"], environment);
    }
  }, 20_000);

  it("reuses a healthy session and shutdown stops it while retaining its logs", async () => {
    const workspace = createWorkspace();
    const port = await reservePort();
    const environment = makeEnvironment(workspace, port);
    const commandPath = join(workspace, "offline-pgn-reader");

    const firstStart = runCommand(commandPath, ["--install-mobile"], environment);
    expect(firstStart.status, firstStart.error?.message ?? firstStart.stderr).toBe(0);

    const eventsBeforeReuse = readEvents(workspace);
    const previewPid = requiredPid(eventsBeforeReuse, "npm", "serve:mobile");
    const tunnelPid = requiredPid(eventsBeforeReuse, "cloudflared", "tunnel");
    expect(isProcessRunning(previewPid)).toBe(true);
    expect(isProcessRunning(tunnelPid)).toBe(true);

    const secondStart = runCommand(commandPath, ["--install-mobile"], environment);
    expect(secondStart.status, secondStart.error?.message ?? secondStart.stderr).toBe(0);
    expect(secondStart.stdout).toBe(firstStart.stdout);
    expect(readEvents(workspace)).toHaveLength(eventsBeforeReuse.length);

    const shutdown = runCommand(commandPath, ["--shutdown"], environment);
    expect(shutdown.status, shutdown.error?.message ?? shutdown.stderr).toBe(0);
    expect(shutdown.stdout).toContain("Mobile install session stopped");
    await waitForProcessExit(previewPid);
    await waitForProcessExit(tunnelPid);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();

    const stateDirectory = join(workspace, ".offline-pgn-reader");
    expect(existsSync(join(stateDirectory, "session.json"))).toBe(false);
    expect(existsSync(join(stateDirectory, "preview.log"))).toBe(true);
    expect(existsSync(join(stateDirectory, "cloudflared.log"))).toBe(true);

    const repeatedShutdown = runCommand(commandPath, ["--shutdown"], environment);
    expect(repeatedShutdown.status).toBe(0);
    expect(repeatedShutdown.stdout).toContain("No active mobile install session");
  });

  it("restarts a live session when its public URL no longer serves the app", async () => {
    const workspace = createWorkspace();
    const port = await reservePort();
    const environment = makeEnvironment(workspace, port);
    const commandPath = join(workspace, "offline-pgn-reader");
    const firstStart = runCommand(commandPath, ["--install-mobile"], environment);
    expect(firstStart.status).toBe(0);

    const initialEvents = readEvents(workspace);
    const oldPreviewPid = requiredPid(initialEvents, "npm", "serve:mobile");
    const oldTunnelPid = requiredPid(initialEvents, "cloudflared", "tunnel");
    const unavailableEnvironment = {
      ...environment,
      MOBILE_TEST_PUBLIC_UNAVAILABLE: "1",
      MOBILE_TEST_TUNNEL_URL: "https://mobile-restarted.trycloudflare.com",
    };

    const secondStart = runCommand(commandPath, ["--install-mobile"], unavailableEnvironment);
    expect(secondStart.status, secondStart.error?.message ?? secondStart.stderr).toBe(0);
    expect(secondStart.stdout).toContain("https://mobile-restarted.trycloudflare.com");
    expect(isProcessRunning(oldPreviewPid)).toBe(false);
    expect(isProcessRunning(oldTunnelPid)).toBe(false);

    const events = readEvents(workspace);
    const newPreviewPid = requiredPidAfter(events, "npm", "serve:mobile", initialEvents.length);
    const newTunnelPid = requiredPidAfter(events, "cloudflared", "tunnel", initialEvents.length);
    expect(isProcessRunning(newPreviewPid)).toBe(true);
    expect(isProcessRunning(newTunnelPid)).toBe(true);
    expect(readFileSync(join(workspace, "tunnel-fetches.jsonl"), "utf8"))
      .toContain("https://mobile-test.trycloudflare.com");
  });

  it("leaves an unrelated listener alone when the selected port is occupied", async () => {
    const workspace = createWorkspace();
    const listener = await startFixtureListener();
    const environment = makeEnvironment(workspace, listener.port);

    try {
      const result = runCommand(
        join(workspace, "offline-pgn-reader"),
        ["--install-mobile"],
        environment,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Port ${listener.port} is already in use`);
      expect(existsSync(join(workspace, "events.jsonl"))).toBe(false);

      const response = await fetch(`http://127.0.0.1:${listener.port}/`);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("<title>PGN Reader Mobile</title>");
      expect(html).toContain("id=\"import-title\">PGN sources</h1>");
    } finally {
      await closeFixtureListener(listener.server);
    }
  });

  it("stops the preview when the tunnel exits during startup", async () => {
    const workspace = createWorkspace();
    const port = await reservePort();
    const environment = {
      ...makeEnvironment(workspace, port),
      MOBILE_TEST_CLOUDFLARED_MODE: "exit",
    };
    const commandPath = join(workspace, "offline-pgn-reader");

    const result = runCommand(commandPath, ["--install-mobile"], environment);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cloudflared exited before the tunnel became ready");
    expect(result.stderr).toContain("Session logs: ");
    expect(result.stderr).toContain(".offline-pgn-reader");

    const events = readEvents(workspace);
    const previewPid = requiredPid(events, "npm", "serve:mobile");
    const tunnelPid = requiredPid(events, "cloudflared", "tunnel");
    await waitForProcessExit(previewPid);
    await waitForProcessExit(tunnelPid);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    expect(existsSync(join(workspace, ".offline-pgn-reader", "session.json"))).toBe(false);
  });

  it("stops a spawned child when its process group cannot be verified", async () => {
    const workspace = createWorkspace();
    writeExecutable(join(workspace, "fake-bin", "ps"), fakePsSource);
    const port = await reservePort();
    const environment = makeEnvironment(workspace, port);
    const result = runCommand(
      join(workspace, "offline-pgn-reader"),
      ["--install-mobile"],
      environment,
    );
    const previewPid = requiredPid(readEvents(workspace), "npm", "serve:mobile");

    try {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Could not verify the detached npm process group");
      await waitForProcessExit(previewPid);
    } finally {
      if (isWorkspaceFixtureProcess(previewPid, workspace)) process.kill(previewPid, "SIGTERM");
    }
  });

  it("checks for cloudflared before installing dependencies", () => {
    const workspace = createWorkspace();
    const port = 8431;
    const environment = {
      ...makeEnvironment(workspace, port),
      MOBILE_TEST_CLOUDFLARED_MODE: "missing",
    };

    const result = runCommand(
      join(workspace, "offline-pgn-reader"),
      ["--install-mobile"],
      environment,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cloudflared is required");
    expect(existsSync(join(workspace, "events.jsonl"))).toBe(false);
  });

  it("replaces a stale session instead of keeping its surviving preview", async () => {
    const workspace = createWorkspace();
    const port = await reservePort();
    const environment = makeEnvironment(workspace, port);
    const commandPath = join(workspace, "offline-pgn-reader");
    const firstStart = runCommand(commandPath, ["--install-mobile"], environment);
    expect(firstStart.status).toBe(0);

    const initialEvents = readEvents(workspace);
    const oldPreviewPid = requiredPid(initialEvents, "npm", "serve:mobile");
    const oldTunnelPid = requiredPid(initialEvents, "cloudflared", "tunnel");
    process.kill(oldTunnelPid, "SIGTERM");
    await waitForProcessExit(oldTunnelPid);

    const secondStart = runCommand(commandPath, ["--install-mobile"], environment);
    expect(secondStart.status, secondStart.error?.message ?? secondStart.stderr).toBe(0);

    const events = readEvents(workspace);
    const previewPids = events
      .filter((event) => event.executable === "npm" && event.args.includes("serve:mobile"))
      .flatMap((event) => typeof event.pid === "number" ? [event.pid] : []);
    expect(previewPids).toHaveLength(2);
    const newPreviewPid = previewPids[1];
    expect(isProcessRunning(oldPreviewPid)).toBe(false);
    expect(isProcessRunning(newPreviewPid)).toBe(true);
    expect(events.filter((event) => event.executable === "cloudflared" &&
      event.args.includes("tunnel"))).toHaveLength(2);
  });

  it("uses SIGKILL when a managed process ignores the shutdown grace period", async () => {
    const workspace = createWorkspace();
    const port = await reservePort();
    const environment = {
      ...makeEnvironment(workspace, port),
      MOBILE_TEST_CLOUDFLARED_MODE: "ignore-term",
    };
    const commandPath = join(workspace, "offline-pgn-reader");
    const start = runCommand(commandPath, ["--install-mobile"], environment);
    expect(start.status, start.error?.message ?? start.stderr).toBe(0);

    const tunnelPid = requiredPid(readEvents(workspace), "cloudflared", "tunnel");
    const shutdown = runCommand(commandPath, ["--shutdown"], environment);
    expect(shutdown.status, shutdown.error?.message ?? shutdown.stderr).toBe(0);
    await waitForProcessExit(tunnelPid);
  });
});

type RecordedEvent = {
  executable: string;
  args: string[];
  pid?: number;
};

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "offline-pgn-mobile-"));
  workspaces.push(workspace);
  mkdirSync(join(workspace, "scripts"));
  mkdirSync(join(workspace, "fake-bin"));

  copyIfPresent(join(repositoryRoot, "offline-pgn-reader"), join(workspace, "offline-pgn-reader"));
  copyIfPresent(
    join(repositoryRoot, "scripts", "mobile-tunnel.mjs"),
    join(workspace, "scripts", "mobile-tunnel.mjs"),
  );

  writeExecutable(join(workspace, "fake-bin", "npm"), fakeNpmSource);
  writeExecutable(join(workspace, "fake-bin", "cloudflared"), fakeCloudflaredSource);
  writeFileSync(join(workspace, "fetch-preload.mjs"), fetchPreloadSource);
  return workspace;
}

function copyIfPresent(source: string, destination: string): void {
  if (!existsSync(source)) return;
  copyFileSync(source, destination);
  if (destination.endsWith("offline-pgn-reader")) chmodSync(destination, 0o755);
}

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function makeEnvironment(workspace: string, port: number): NodeJS.ProcessEnv {
  const preload = JSON.stringify(join(workspace, "fetch-preload.mjs"));
  return {
    ...process.env,
    PATH: `${join(workspace, "fake-bin")}:${process.env.PATH ?? ""}`,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`.trim(),
    PGNREADER_MOBILE_PORT: String(port),
    MOBILE_TEST_EVENTS: join(workspace, "events.jsonl"),
    MOBILE_TEST_FETCH_EVENTS: join(workspace, "tunnel-fetches.jsonl"),
    MOBILE_TEST_TUNNEL_URL: "https://mobile-test.trycloudflare.com",
  };
}

function runCommand(
  commandPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  return spawnSync(commandPath, args, {
    cwd: tmpdir(),
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
}

function requiredPid(events: RecordedEvent[], executable: string, argument: string): number {
  const event = events.find((candidate) =>
    candidate.executable === executable && candidate.args.includes(argument));
  if (typeof event?.pid !== "number") throw new Error(`No ${executable} PID recorded`);
  return event.pid;
}

function requiredPidAfter(
  events: RecordedEvent[],
  executable: string,
  argument: string,
  startIndex: number,
): number {
  const event = events.slice(startIndex).find((candidate) =>
    candidate.executable === executable && candidate.args.includes(argument));
  if (typeof event?.pid !== "number") throw new Error(`No new ${executable} PID recorded`);
  return event.pid;
}

function isProcessRunning(pid: number): boolean {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "stat="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && !result.stdout.trim().startsWith("Z");
}

function isWorkspaceFixtureProcess(pid: number, workspace: string): boolean {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && result.stdout.includes(join(workspace, "fake-bin", "npm"));
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline && isProcessRunning(pid)) await delay(50);
  expect(isProcessRunning(pid)).toBe(false);
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a test port");
  await closeFixtureListener(server);
  return address.port;
}

async function waitForTunnelLog(workspace: string, launcher: ReturnType<typeof spawn>): Promise<void> {
  const logPath = join(workspace, ".offline-pgn-reader", "cloudflared.log");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(logPath) && /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.test(readFileSync(logPath, "utf8"))) {
      return;
    }
    if (launcher.exitCode !== null) break;
    await delay(50);
  }
  throw new Error("The fake tunnel did not emit a Quick Tunnel URL");
}

async function startFixtureListener(): Promise<{ server: ReturnType<typeof createServer>, port: number }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>PGN Reader Mobile</title><h1 id=\"import-title\">PGN sources</h1>");
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start the fixture listener");
  return { server, port: address.port };
}

async function closeFixtureListener(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

function readEvents(workspace: string): RecordedEvent[] {
  return readFileSync(join(workspace, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(parseEvent);
}

function parseEvent(line: string): RecordedEvent {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" ||
      !("executable" in value) || typeof value.executable !== "string" ||
      !("args" in value) || !Array.isArray(value.args)) {
    throw new Error("Fake executable wrote an invalid test event");
  }
  const rawArgs: unknown[] = value.args;
  const args = rawArgs.filter((argument): argument is string => typeof argument === "string");
  if (args.length !== rawArgs.length) throw new Error("Fake executable wrote invalid arguments");
  const pid = "pid" in value && typeof value.pid === "number" ? value.pid : undefined;
  return {
    executable: value.executable,
    args,
    ...(pid === undefined ? {} : { pid }),
  };
}

const fakeNpmSource = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const args = process.argv.slice(2);
const event = { executable: "npm", args, pid: process.pid };
appendFileSync(process.env.MOBILE_TEST_EVENTS, JSON.stringify(event) + "\\n");

if (args[0] === "run" && args[1] === "serve:mobile") {
  const html = "<!doctype html><title>PGN Reader Mobile</title><h1 id=\\\"import-title\\\">PGN sources</h1>";
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(html);
  });
  server.listen(Number(process.env.PGNREADER_MOBILE_PORT), "127.0.0.1", () => {
    process.stdout.write("Mobile PWA static server listening\\n");
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
`;

const fakeCloudflaredSource = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  if (process.env.MOBILE_TEST_CLOUDFLARED_MODE === "missing") process.exit(127);
  process.stdout.write("cloudflared version test\\n");
  process.exit(0);
}
appendFileSync(process.env.MOBILE_TEST_EVENTS, JSON.stringify({
  executable: "cloudflared",
  args,
  pid: process.pid,
}) + "\\n");
if (process.env.MOBILE_TEST_CLOUDFLARED_MODE === "exit") {
  process.stderr.write("fake tunnel startup failed\\n");
  process.exit(3);
}
process.stdout.write("https://" + new URL(process.env.MOBILE_TEST_TUNNEL_URL).host + "\\n");
process.on("SIGTERM", () => {
  if (process.env.MOBILE_TEST_CLOUDFLARED_MODE !== "ignore-term") process.exit(0);
});
process.on("SIGINT", () => process.exit(0));
setInterval(() => {}, 60_000);
`;

const fakePsSource = `#!/usr/bin/env node
if (process.argv.includes("pgid=")) process.stdout.write("1\\n");
else process.stdout.write("FAKE START\\n");
`;

const fetchPreloadSource = `import { appendFileSync } from "node:fs";

const fetchOriginal = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  const inputUrl = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (inputUrl.hostname.endsWith(".trycloudflare.com")) {
    appendFileSync(process.env.MOBILE_TEST_FETCH_EVENTS, JSON.stringify({ url: inputUrl.href }) + "\\n");
    if (process.env.MOBILE_TEST_PUBLIC_UNAVAILABLE === "1") {
      return Promise.resolve(new Response("Quick Tunnel route is still starting", { status: 530 }));
    }
    inputUrl.protocol = "http:";
    inputUrl.hostname = "127.0.0.1";
    inputUrl.port = process.env.PGNREADER_MOBILE_PORT;
  }
  return fetchOriginal(inputUrl, init);
};
`;
