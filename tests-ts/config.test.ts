import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { readConfig } from "../src/config.js";

describe("local process configuration", () => {
  it("expands a home-relative data directory like the Python runtime", () => {
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
});
