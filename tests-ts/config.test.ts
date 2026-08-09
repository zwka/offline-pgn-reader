import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { readConfig } from "../src/config.js";

describe("local process configuration", () => {
  it("expands a home-relative data directory consistently", () => {
    const configured = readConfig({
      PGNREADER_DATA_DIR: "~/offline-pgn-reader-data",
      PGNREADER_HOST: "0.0.0.0",
      PGNREADER_PORT: "9000",
    });

    expect(configured.host).toBe("0.0.0.0");
    expect(configured.port).toBe(9000);
    expect(configured.dbPath).toBe(join(homedir(), "offline-pgn-reader-data", "index.sqlite3"));
  });

  it("resolves the configured watch directories in order", () => {
    const configured = readConfig({
      PGNREADER_WATCH_DIRS: "~/pgn-sources:./tests/fixtures",
    });

    expect(configured.watchDirs).toEqual([
      join(homedir(), "pgn-sources"),
      resolve("tests/fixtures"),
    ]);
  });

  it("resolves the managed upload directory", () => {
    const configured = readConfig({ PGNREADER_UPLOAD_DIR: "~/pgn-library" });

    expect(configured.uploadDir).toBe(join(homedir(), "pgn-library"));
  });

  it("keeps debug and hydration limits configurable", () => {
    const configured = readConfig({
      PGNREADER_DEBUG: "yes",
      PGNREADER_MAX_GAME_BYTES: "4096",
    });

    expect(configured.debug).toBe(true);
    expect(configured.maxGameBytes).toBe(4096);
    expect(() => readConfig({ PGNREADER_MAX_GAME_BYTES: "0" })).toThrow(
      "PGNREADER_MAX_GAME_BYTES must be a positive integer",
    );
  });
});
