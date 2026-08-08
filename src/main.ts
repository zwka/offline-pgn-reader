import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";

import { config as defaultConfig, type AppConfig } from "./config.js";
import { SqliteIndex } from "./index.js";
import { LibraryService } from "./library.js";
import { buildServer } from "./server.js";

const CLI_USAGE = `Usage: pgnreader <command> [options]

Commands:
  serve [--host HOST] [--port PORT] [--reload]
  index [--force] PATH...
  reset

Running without a command starts the server with the configured defaults.`;

type ServeCommand = {
  command: "serve";
  host: string;
  port: number;
  reload: boolean;
};

type IndexCommand = {
  command: "index";
  force: boolean;
  paths: string[];
};

type ResetCommand = { command: "reset" };
type HelpCommand = { command: "help" };
export type CliCommand = ServeCommand | IndexCommand | ResetCommand | HelpCommand;

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export type CliDependencies = {
  config?: AppConfig;
  startServer?: (options: Partial<AppConfig>) => Promise<FastifyInstance>;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
};

export function parseCommand(
  argv: readonly string[],
  appConfig: AppConfig = defaultConfig,
): CliCommand {
  if (argv.length === 0) {
    return { command: "serve", host: appConfig.host, port: appConfig.port, reload: false };
  }

  const [name, ...args] = argv;
  if (name === "-h" || name === "--help") return { command: "help" };
  if (name === "serve") return parseServeCommand(args, appConfig);
  if (name === "index") return parseIndexCommand(args);
  if (name === "reset") {
    if (args.length === 0) return { command: "reset" };
    if (args.length === 1 && (args[0] === "-h" || args[0] === "--help")) {
      return { command: "help" };
    }
    throw new CliUsageError(`reset does not accept arguments: ${args.join(" ")}`);
  }
  throw new CliUsageError(`unknown command: ${name}`);
}

export async function startServer(options: Partial<AppConfig> = {}): Promise<FastifyInstance> {
  const appConfig: AppConfig = { ...defaultConfig, ...options };
  const server = buildServer(appConfig);
  try {
    await server.listen({ host: appConfig.host, port: appConfig.port });
  } catch (error) {
    server.log.error({ err: error }, "Failed to start server");
    throw error;
  }
  return server;
}

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number> {
  const appConfig = dependencies.config ?? defaultConfig;
  const stdout = dependencies.stdout ?? ((message: string) => console.log(message));
  const stderr = dependencies.stderr ?? ((message: string) => console.error(message));

  try {
    const command = parseCommand(argv, appConfig);
    if (command.command === "help") {
      stdout(CLI_USAGE);
      return 0;
    }
    if (command.command === "serve") {
      return await runServe(command, appConfig, dependencies, stdout, stderr);
    }
    if (command.command === "index") {
      return await runIndex(command, appConfig, stdout, stderr);
    }
    return await runReset(appConfig, stdout, stderr);
  } catch (error) {
    if (error instanceof CliUsageError) {
      stderr(`Argument error: ${error.message}\n${CLI_USAGE}`);
      return 2;
    }
    stderr(`Command failed: ${errorMessage(error)}`);
    return 1;
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  return runCli(argv);
}

async function runServe(
  command: ServeCommand,
  appConfig: AppConfig,
  dependencies: CliDependencies,
  stdout: (message: string) => void,
  stderr: (message: string) => void,
): Promise<number> {
  try {
    const launch = dependencies.startServer ?? startServer;
    const server = await launch({ ...appConfig, host: command.host, port: command.port });
    void command.reload;
    server.log.info(
      { address: `http://${command.host}:${command.port}` },
      "Offline PGN Reader listening",
    );
    stdout(`Offline PGN Reader listening at http://${command.host}:${command.port}`);
    const shutdown = async () => {
      await server.close();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return 0;
  } catch (error) {
    stderr(`Serve failed: ${errorMessage(error)}`);
    return 1;
  }
}

async function runIndex(
  command: IndexCommand,
  appConfig: AppConfig,
  stdout: (message: string) => void,
  stderr: (message: string) => void,
): Promise<number> {
  let service: LibraryService | undefined;
  try {
    service = new LibraryService(
      new SqliteIndex(appConfig.dbPath),
      appConfig.watchDirs,
      appConfig.uploadDir,
      appConfig.maxGameBytes,
    );
    for (const path of command.paths) {
      const registered = service.registerFile(path, false);
      const indexed = await service.scanFileSync(registered.id, command.force);
      if (indexed.scan_status === "error") {
        throw new Error(indexed.scan_error ?? `scan failed for ${indexed.path}`);
      }
      stdout(
        `${indexed.name}: ${indexed.game_count} games, ` +
          `${indexed.warning_count} warnings, status=${indexed.scan_status}`,
      );
    }
    return 0;
  } catch (error) {
    stderr(`Index failed: ${errorMessage(error)}`);
    return 1;
  } finally {
    await service?.close();
  }
}

async function runReset(
  appConfig: AppConfig,
  stdout: (message: string) => void,
  stderr: (message: string) => void,
): Promise<number> {
  let service: LibraryService | undefined;
  try {
    service = new LibraryService(
      new SqliteIndex(appConfig.dbPath),
      appConfig.watchDirs,
      appConfig.uploadDir,
      appConfig.maxGameBytes,
    );
    service.resetIndex();
    stdout(`Index reset: ${appConfig.dbPath}`);
    return 0;
  } catch (error) {
    stderr(`Reset failed: ${errorMessage(error)}`);
    return 1;
  } finally {
    await service?.close();
  }
}

function parseServeCommand(
  args: readonly string[],
  appConfig: AppConfig,
): ServeCommand | HelpCommand {
  let host = appConfig.host;
  let port = appConfig.port;
  let reload = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-h" || argument === "--help") return { command: "help" };
    if (argument === "--reload") {
      reload = true;
      continue;
    }
    if (argument === "--host") {
      host = optionValue(args, ++index, "--host");
      continue;
    }
    if (argument.startsWith("--host=")) {
      host = argument.slice("--host=".length);
      if (!host) throw new CliUsageError("--host requires a value");
      continue;
    }
    if (argument === "--port") {
      port = parsePort(optionValue(args, ++index, "--port"));
      continue;
    }
    if (argument.startsWith("--port=")) {
      port = parsePort(argument.slice("--port=".length));
      continue;
    }
    throw new CliUsageError(`unknown serve option: ${argument}`);
  }

  return { command: "serve", host, port, reload };
}

function parseIndexCommand(args: readonly string[]): IndexCommand | HelpCommand {
  let force = false;
  let paths: string[] = [];
  let positionalOnly = false;

  for (const argument of args) {
    if (!positionalOnly && (argument === "-h" || argument === "--help")) {
      return { command: "help" };
    }
    if (!positionalOnly && argument === "--force") {
      force = true;
      continue;
    }
    if (!positionalOnly && argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && argument.startsWith("-")) {
      throw new CliUsageError(`unknown index option: ${argument}`);
    }
    paths.push(argument);
  }

  if (paths.length === 0) throw new CliUsageError("index requires at least one PGN path");
  return { command: "index", force, paths };
}

function optionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("-")) throw new CliUsageError(`${option} requires a value`);
  return value;
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new CliUsageError("--port must be an integer between 1 and 65535");
  }
  return port;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((exitCode) => {
    if (exitCode !== 0) process.exitCode = exitCode;
  }).catch((error: unknown) => {
    console.error(`Command failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
