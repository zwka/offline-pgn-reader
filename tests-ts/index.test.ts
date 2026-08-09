import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "../src/database.js";
import { SqliteIndex, type Index } from "../src/index.js";

const directories: string[] = [];

afterEach(() => {
  directories.splice(0).forEach((directory) => {
    rmSync(directory, { force: true, recursive: true });
  });
});

function testIndex(): { directory: string; sourcePath: string; index: Index } {
  const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-index-"));
  directories.push(directory);
  const sourcePath = join(directory, "source.pgn");
  writeFileSync(sourcePath, readFileSync(resolve("tests/fixtures/basic_two_games.pgn")));
  return {
    directory,
    sourcePath,
    index: new SqliteIndex(join(directory, "index.sqlite3")),
  };
}

describe("Index persistence interface", () => {
  it("rejects a source that changes during scan without replacing its prior games", async () => {
    const { sourcePath, index } = testIndex();
    const source = index.registerFile(sourcePath, "source.pgn");

    expect(index.claimScan(source.id)).toBe(true);
    await index.replaceGames(source.id, sourcePath);
    const before = index.listGames(source.id);

    writeFileSync(
      sourcePath,
      '[Event "Large"]\n\n1. ' + "e4 ".repeat(1_400_000) + "*\n",
      "utf8",
    );
    expect(index.claimScan(source.id)).toBe(true);
    let changed = false;

    await expect(index.replaceGames(source.id, sourcePath, (bytesDone) => {
      if (bytesDone > 0 && !changed) {
        changed = true;
        writeFileSync(sourcePath, Buffer.concat([readFileSync(sourcePath), Buffer.from("\n")]));
      }
    })).rejects.toThrow("source changed during scan");

    expect(changed).toBe(true);
    expect(index.listGames(source.id)).toEqual(before);
    expect(index.getFile(source.id)).toMatchObject({
      scan_status: "error",
      scan_error: "source changed during scan",
    });
  });

  it("replaces source games, preserves ordered tags, and resets the schema", async () => {
    const { directory, sourcePath, index } = testIndex();
    const source = index.registerFile(sourcePath, "source.pgn");

    expect(index.claimScan(source.id)).toBe(true);
    await index.replaceGames(source.id, sourcePath);
    expect(index.getFile(source.id)).toMatchObject({
      scan_status: "ready",
      game_count: 2,
      scan_error: null,
    });
    const page = index.listGames(source.id);
    expect(page.games).toHaveLength(2);
    expect(index.getGameTags(page.games[0].id)).toEqual([
      ["Event", "Test Open"],
      ["Site", "Localville"],
      ["Date", "2024.01.15"],
      ["Round", "1"],
      ["White", "Alpha, A."],
      ["Black", "Beta, B."],
      ["Result", "1-0"],
      ["ECO", "C50"],
    ]);

    index.reset();
    expect(index.listFiles()).toEqual([]);
    const database = new Database(join(directory, "index.sqlite3"));
    try {
      expect(database
        .prepare("SELECT value FROM meta WHERE key='schema_version'")
        .get()).toEqual({ value: String(SCHEMA_VERSION) });
      expect(database.prepare("SELECT COUNT(*) AS count FROM games").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("keeps previous games and marks the scan failed when replacement is rejected", async () => {
    const { directory, sourcePath, index } = testIndex();
    const source = index.registerFile(sourcePath, "source.pgn");
    expect(index.claimScan(source.id)).toBe(true);
    await index.replaceGames(source.id, sourcePath);
    const before = index.listGames(source.id);

    const database = new Database(join(directory, "index.sqlite3"));
    try {
      database.exec(
        `CREATE TRIGGER reject_replacement BEFORE INSERT ON games
         WHEN NEW.file_id=${source.id}
         BEGIN SELECT RAISE(ABORT, 'replacement rejected'); END;`,
      );
    } finally {
      database.close();
    }

    expect(index.claimScan(source.id)).toBe(true);
    await expect(index.replaceGames(source.id, sourcePath)).rejects
      .toThrow("replacement rejected");
    expect(index.listGames(source.id)).toEqual(before);
    expect(index.getFile(source.id)).toMatchObject({
      scan_status: "error",
      scan_error: expect.stringContaining("replacement rejected"),
      game_count: 2,
    });
  });
});
