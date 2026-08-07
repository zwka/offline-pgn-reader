import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_VERSION = "1.1.0";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export type AppConfig = {
  host: string;
  port: number;
  version: string;
  frontendDir: string;
  dbPath: string;
};

function readPort(raw: string | undefined): number {
  const port = Number(raw ?? "8642");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PGNREADER_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function resolveConfiguredPath(raw: string | undefined, fallback: string): string {
  return raw ? (isAbsolute(raw) ? raw : resolve(projectRoot, raw)) : fallback;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = resolveConfiguredPath(env.PGNREADER_DATA_DIR, resolve(projectRoot, "data"));
  return {
    host: env.PGNREADER_HOST ?? "127.0.0.1",
    port: readPort(env.PGNREADER_PORT),
    version: APP_VERSION,
    frontendDir: fileURLToPath(new URL("../frontend/", import.meta.url)),
    dbPath: resolve(dataDir, "index.sqlite3"),
  };
}

export const config = readConfig();
