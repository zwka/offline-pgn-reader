import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LibraryService, ServiceError } from "../src/library.js";
import { parseCommand, runCli, type CliDependencies } from "../src/main.js";
import type { AppConfig } from "../src/config.js";

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  directories.splice(0).forEach((directory) => {
    rmSync(directory, { force: true, recursive: true });
  });
});

function testConfig(directory: string): AppConfig {
  return {
    host: "127.0.0.1",
    port: 8642,
    version: "1.1.0",
    frontendDir: resolve("frontend"),
    dbPath: join(directory, "data", "index.sqlite3"),
    watchDirs: [],
    uploadDir: join(directory, "library"),
  };
}

function isolatedCommand() {
  const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-ts-cli-"));
  directories.push(directory);
  const output: string[] = [];
  const errors: string[] = [];
  const config = testConfig(directory);
  const dependencies: CliDependencies = {
    config,
    stdout: (message) => output.push(message),
    stderr: (message) => errors.push(message),
  };
  return { directory, config, output, errors, dependencies };
}

describe("TypeScript command entry point", () => {
  it("keeps the server and index command options available", () => {
    const config = testConfig("/tmp/offline-pgn-reader-cli-config");

    expect(parseCommand(["serve", "--host", "0.0.0.0", "--port", "9000", "--reload"], config))
      .toEqual({ command: "serve", host: "0.0.0.0", port: 9000, reload: true });
    expect(parseCommand(["index", "--force", "one.pgn", "two.pgn"], config)).toEqual({
      command: "index",
      force: true,
      paths: ["one.pgn", "two.pgn"],
    });
    expect(parseCommand(["reset"], config)).toEqual({ command: "reset" });
  });

  it("indexes an isolated source, skips an unchanged source, and force-reindexes it", async () => {
    const { directory, config, output, errors, dependencies } = isolatedCommand();
    const source = join(directory, "source.pgn");
    writeFileSync(source, '[Event "First"]\n\n1. e4 *\n', "utf8");

    expect(await runCli(["index", source], dependencies)).toBe(0);
    expect(output).toEqual(["source.pgn: 1 games, 0 warnings, status=ready"]);
    expect(errors).toEqual([]);

    const database = new Database(config.dbPath);
    const firstScan = database
      .prepare("SELECT scanned_at FROM files WHERE path=?")
      .get(realpathSync(source)) as { scanned_at: string };
    database.close();

    output.length = 0;
    expect(await runCli(["index", source], dependencies)).toBe(0);
    expect(output).toEqual(["source.pgn: 1 games, 0 warnings, status=ready"]);
    const skippedDatabase = new Database(config.dbPath);
    const skippedScan = skippedDatabase
      .prepare("SELECT scanned_at FROM files WHERE path=?")
      .get(realpathSync(source)) as { scanned_at: string };
    skippedDatabase.close();
    expect(skippedScan.scanned_at).toBe(firstScan.scanned_at);

    const forceDatabase = new Database(config.dbPath);
    forceDatabase.exec(
      "CREATE TABLE scan_events (id INTEGER PRIMARY KEY);" +
        "CREATE TRIGGER record_replacement BEFORE DELETE ON games " +
        "BEGIN INSERT INTO scan_events(id) VALUES (NULL); END;",
    );
    forceDatabase.close();

    appendFileSync(source, '\n[Event "Second"]\n\n1. d4 *\n', "utf8");
    output.length = 0;
    expect(await runCli(["index", "--force", source], dependencies)).toBe(0);
    expect(output).toEqual(["source.pgn: 2 games, 0 warnings, status=ready"]);

    const updatedDatabase = new Database(config.dbPath);
    try {
      const record = updatedDatabase
        .prepare("SELECT game_count, fingerprint FROM files WHERE path=?")
        .get(realpathSync(source)) as { game_count: number; fingerprint: string };
      expect(record.game_count).toBe(2);
      expect(record.fingerprint).toMatch(/^[0-9a-f]{40}$/);
      expect(record.fingerprint).not.toBe("");
      expect(updatedDatabase.prepare("SELECT COUNT(*) AS count FROM scan_events").get())
        .toEqual({ count: 1 });
    } finally {
      updatedDatabase.close();
    }
    expect(firstScan.scanned_at).toBeTruthy();
  });

  it("returns a useful non-zero result for an index failure", async () => {
    const { directory, errors, dependencies } = isolatedCommand();

    expect(await runCli(["index", join(directory, "missing.pgn")], dependencies)).toBe(1);
    expect(errors[0]).toContain("Index failed");
    expect(errors[0]).toContain("not a file");
  });

  it("resets isolated Library data and reports reset failures", async () => {
    const { directory, config, output, errors, dependencies } = isolatedCommand();
    const source = join(directory, "source.pgn");
    writeFileSync(source, '[Event "Reset"]\n\n1. e4 *\n', "utf8");
    expect(await runCli(["index", source], dependencies)).toBe(0);

    output.length = 0;
    expect(await runCli(["reset"], dependencies)).toBe(0);
    expect(output).toEqual([`Index reset: ${config.dbPath}`]);

    const database = new Database(config.dbPath);
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM files").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM games").get()).toEqual({ count: 0 });
      expect(readFileSync(source).toString()).toContain("Reset");
    } finally {
      database.close();
    }

    vi.spyOn(LibraryService.prototype, "resetIndex").mockImplementation(() => {
      throw new ServiceError("cannot reset while a scan is running", 409);
    });
    expect(await runCli(["reset"], dependencies)).toBe(1);
    expect(errors.at(-1)).toContain("cannot reset while a scan is running");
  });

  it("starts the server with compatible serve options", async () => {
    const { config, output, dependencies } = isolatedCommand();
    const close = vi.fn(async () => undefined);
    const info = vi.fn();
    const startServer = vi.fn(async () => ({
      close,
      log: { info },
    } as never));

    const result = await runCli(
      ["serve", "--host=0.0.0.0", "--port=9000", "--reload"],
      { ...dependencies, startServer },
    );

    expect(result).toBe(0);
    expect(startServer).toHaveBeenCalledWith({ ...config, host: "0.0.0.0", port: 9000 });
    expect(output).toEqual(["Offline PGN Reader listening at http://0.0.0.0:9000"]);
    expect(info).toHaveBeenCalledWith(
      { address: "http://0.0.0.0:9000" },
      "Offline PGN Reader listening",
    );
  });
});
