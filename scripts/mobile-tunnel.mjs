import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const startupTimeoutMs = 60_000;
const shutdownGraceMs = 1_500;
const appMarkers = [
  "<title>PGN Reader Mobile</title>",
  'id="import-title">PGN sources</h1>',
];

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function runMobileCommand(args) {
  const command = parseCommand(args);
  const stateDirectory = join(workspaceRoot, ".offline-pgn-reader");

  if (command === "shutdown" && !existsSync(stateDirectory)) {
    process.stdout.write("No active mobile install session.\n");
    return;
  }

  if (command === "install") mkdirSync(stateDirectory, { recursive: true });
  await withWorkspaceLock(stateDirectory, async () => {
    if (command === "shutdown") {
      await shutdownSession(stateDirectory);
      return;
    }
    await startSession(stateDirectory);
  });
}

function parseCommand(args) {
  if (args.length === 1 && args[0] === "--install-mobile") return "install";
  if (args.length === 1 && args[0] === "--shutdown") return "shutdown";
  throw new Error("Usage: ./offline-pgn-reader --install-mobile | --shutdown");
}

async function startSession(stateDirectory) {
  const port = parsePort(process.env.PGNREADER_MOBILE_PORT);
  const statePath = join(stateDirectory, "session.json");
  const existing = readSession(statePath);

  if (existing) {
    if (existing.port === port && await isHealthySession(existing)) {
      process.stdout.write(`${existing.url}\n`);
      return;
    }
    await stopSession(existing);
    removeState(statePath);
  }

  checkCloudflared();
  await checkPortAvailable(port);

  const previewLog = join(stateDirectory, "preview.log");
  const tunnelLog = join(stateDirectory, "cloudflared.log");
  writeFileSync(previewLog, "");
  writeFileSync(tunnelLog, "");

  let state = { version: 1, port };
  const persist = () => writeSession(statePath, state);

  try {
    runForeground("npm", ["install"]);
    runForeground("npm", ["run", "build"]);

    state.preview = await startBackground(
      "npm",
      ["run", "serve:mobile"],
      { PGNREADER_MOBILE_PORT: String(port) },
      previewLog,
      ["run serve:mobile", "src/mobile-static-server.ts"],
    );
    persist();
    await waitForPreview(state.preview, port, previewLog);

    state.tunnel = await startBackground(
      "cloudflared",
      ["tunnel", "--url", `http://127.0.0.1:${port}`],
      {},
      tunnelLog,
      [`tunnel --url http://127.0.0.1:${port}`],
    );
    persist();
    state.url = await waitForTunnel(state.tunnel, tunnelLog);
    persist();
    process.stdout.write(`${state.url}\n`);
  } catch (error) {
    await stopSession(state);
    removeState(statePath);
    throw new Error(`${errorMessage(error)}\nSession logs: ${stateDirectory}`);
  }
}

function parsePort(rawPort) {
  const port = rawPort === undefined ? 8431 : Number(rawPort);
  if (!isValidPort(port)) {
    throw new Error("PGNREADER_MOBILE_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function isValidPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function checkCloudflared() {
  const result = spawnSync("cloudflared", ["--version"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: "ignore",
  });
  if (result.error || result.status !== 0) {
    throw new Error("cloudflared is required. Install it before starting the mobile tunnel.");
  }
}

function runForeground(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

async function checkPortAvailable(port) {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  }).catch((error) => {
    if (error?.code === "EADDRINUSE") {
      throw new Error(`Port ${port} is already in use; no existing listener was changed.`);
    }
    throw error;
  });
  await new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

async function startBackground(command, args, envOverrides, logPath, signatures) {
  const logFd = openSync(logPath, "a", 0o600);
  const child = spawn(command, args, {
    cwd: workspaceRoot,
    env: { ...process.env, ...envOverrides },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  try {
    await new Promise((resolveSpawn, reject) => {
      child.once("spawn", resolveSpawn);
      child.once("error", reject);
    });
  } finally {
    closeSync(logFd);
  }

  child.unref();
  const pid = child.pid;
  if (!pid) {
    await stopSpawnedChild(child);
    throw new Error(`${command} did not expose a process id`);
  }
  const startedAt = await waitForProcessStart(pid);
  const pgid = getProcessGroupId(pid);
  if (!startedAt || pgid !== pid) {
    await stopSpawnedChild(child);
    throw new Error(`Could not verify the detached ${command} process group`);
  }

  return { pid, pgid, startedAt, signatures };
}

async function stopSpawnedChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, shutdownGraceMs)) return;
  child.kill("SIGKILL");
  await waitForChildExit(child, 1_000);
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const finish = (exited) => {
      clearTimeout(timer);
      child.off("close", onClose);
      resolveExit(exited);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => {
      finish(child.exitCode !== null || child.signalCode !== null);
    }, timeoutMs);
    child.once("close", onClose);
  });
}

async function waitForProcessStart(pid) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const startedAt = getProcessStartTime(pid);
    if (startedAt) return startedAt;
    await delay(25);
  }
  return undefined;
}

async function waitForPreview(processRecord, port, logPath) {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (!isOwnedGroupAlive(processRecord)) {
      throw new Error(`The mobile preview server exited. See ${logPath}`);
    }
    const log = readLog(logPath);
    if (
      log.includes("Mobile PWA static server listening") &&
      await servesExpectedApp(`http://127.0.0.1:${port}`)
    ) {
      return;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for the mobile preview server. See ${logPath}`);
}

async function waitForTunnel(processRecord, logPath) {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (!isOwnedGroupAlive(processRecord)) {
      throw new Error(`cloudflared exited before the tunnel became ready. See ${logPath}`);
    }
    const url = parseTunnelUrl(readLog(logPath));
    if (url) return url;
    await delay(100);
  }
  throw new Error(`Timed out waiting for cloudflared to print a Quick Tunnel URL. See ${logPath}`);
}

function parseTunnelUrl(log) {
  const match = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i);
  return match?.[0];
}

async function servesExpectedApp(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    const html = await response.text();
    return appMarkers.every((marker) => html.includes(marker));
  } catch {
    return false;
  }
}

async function isHealthySession(state) {
  if (!state.url || !state.preview || !state.tunnel) return false;
  if (!isOwnedGroupAlive(state.preview) || !isOwnedGroupAlive(state.tunnel)) return false;
  return await servesExpectedApp(`http://127.0.0.1:${state.port}`) &&
    await servesExpectedApp(state.url);
}

async function shutdownSession(stateDirectory) {
  const statePath = join(stateDirectory, "session.json");
  const state = readSession(statePath);
  if (!state) {
    process.stdout.write("No active mobile install session.\n");
    return;
  }
  await stopSession(state);
  removeState(statePath);
  process.stdout.write("Mobile install session stopped.\n");
}

async function stopSession(state) {
  for (const processRecord of [state.tunnel, state.preview]) {
    if (processRecord) await stopProcessGroup(processRecord);
  }
}

async function stopProcessGroup(processRecord) {
  if (!isOwnedGroupAlive(processRecord)) return;
  try {
    process.kill(-processRecord.pgid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }

  const deadline = Date.now() + shutdownGraceMs;
  while (Date.now() < deadline && isOwnedGroupAlive(processRecord)) await delay(100);
  if (!isOwnedGroupAlive(processRecord)) return;

  try {
    process.kill(-processRecord.pgid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  const killDeadline = Date.now() + 1_000;
  while (Date.now() < killDeadline && isOwnedGroupAlive(processRecord)) await delay(50);
}

function isOwnedGroupAlive(processRecord) {
  if (!processRecord || !Number.isInteger(processRecord.pgid)) return false;
  const members = listProcesses().filter((member) =>
    member.pgid === processRecord.pgid && !member.state.startsWith("Z"));
  if (members.length === 0) return false;

  const leader = members.find((member) => member.pid === processRecord.pid);
  if (leader && getProcessStartTime(leader.pid) !== processRecord.startedAt) return false;
  return members.some((member) => processRecord.signatures.some((signature) =>
    member.command.includes(signature)));
}

function listProcesses() {
  const result = spawnSync("ps", ["-axo", "pid=,pgid=,stat=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return [];

  return result.stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) return [];
    return [{
      pid: Number(match[1]),
      pgid: Number(match[2]),
      state: match[3],
      command: match[4],
    }];
  });
}

function getProcessGroupId(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "pgid="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return undefined;
  const pgid = Number(result.stdout.trim());
  return Number.isInteger(pgid) ? pgid : undefined;
}

function getProcessStartTime(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function readSession(path) {
  if (!existsSync(path)) return undefined;
  let state;
  try {
    state = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Could not read session state safely: ${path}`);
  }
  if (!isSessionState(state)) throw new Error(`Session state is invalid: ${path}`);
  return state;
}

function isSessionState(value) {
  if (!value || typeof value !== "object") return false;
  if (value.version !== 1 || !isValidPort(value.port)) return false;
  if (value.preview !== undefined && !isProcessRecord(value.preview)) return false;
  if (value.tunnel !== undefined && !isProcessRecord(value.tunnel)) return false;
  if (value.url !== undefined && !isQuickTunnelUrl(value.url)) return false;
  return true;
}

function isProcessRecord(value) {
  return Boolean(value && typeof value === "object" &&
    Number.isInteger(value.pid) && value.pid > 0 &&
    Number.isInteger(value.pgid) && value.pgid > 0 &&
    typeof value.startedAt === "string" && value.startedAt.length > 0 &&
    Array.isArray(value.signatures) && value.signatures.length > 0 &&
    value.signatures.every((signature) => typeof signature === "string"));
}

function isQuickTunnelUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      /^[a-z0-9-]+\.trycloudflare\.com$/i.test(url.hostname) &&
      url.port === "" && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function writeSession(path, state) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function removeState(path) {
  rmSync(path, { force: true });
}

function readLog(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function withWorkspaceLock(stateDirectory, operation) {
  const lockPath = join(stateDirectory, "launcher.lock");
  const token = {
    pid: process.pid,
    startedAt: getProcessStartTime(process.pid) ?? String(Date.now()),
    nonce: randomUUID(),
  };
  const deadline = Date.now() + 2_000;
  let lockFd;

  while (lockFd === undefined) {
    let createdFd;
    try {
      createdFd = openSync(lockPath, "wx", 0o600);
      writeFileSync(createdFd, `${JSON.stringify(token)}\n`);
      lockFd = createdFd;
    } catch (error) {
      if (createdFd !== undefined) {
        closeSync(createdFd);
        rmSync(lockPath, { force: true });
      }
      if (error?.code !== "EEXIST") throw error;
      const existing = readLock(lockPath);
      if (existing && getProcessStartTime(existing.pid) === existing.startedAt) {
        throw new Error("Another mobile install command is already running for this workspace.");
      }
      if (existing) {
        if (readLock(lockPath)?.nonce === existing.nonce) rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        try {
          if (Date.now() - statSync(lockPath).mtimeMs >= 1_000) {
            rmSync(lockPath, { force: true });
            continue;
          }
        } catch {
          continue;
        }
        throw new Error(`Could not acquire the workspace lock: ${lockPath}`);
      }
      await delay(50);
    }
  }
  closeSync(lockFd);

  try {
    return await operation();
  } finally {
    const current = readLock(lockPath);
    if (current?.nonce === token.nonce) rmSync(lockPath, { force: true });
  }
}

function readLock(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || !Number.isInteger(value.pid) ||
        typeof value.startedAt !== "string" || typeof value.nonce !== "string") return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
