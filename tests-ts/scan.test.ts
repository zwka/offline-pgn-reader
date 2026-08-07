import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

const servers = [] as ReturnType<typeof buildServer>[];
const testDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  testDirectories.splice(0).forEach((directory) => {
    rmSync(directory, { force: true, recursive: true });
  });
});

function testServer() {
  const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-ts-"));
  testDirectories.push(directory);
  return {
    directory,
    server: buildServer({
      dbPath: join(directory, "index.sqlite3"),
      watchDirs: [],
      uploadDir: join(directory, "library"),
    }),
  };
}

async function waitForReady(server: ReturnType<typeof buildServer>, fileId: number) {
  const deadline = Date.now() + 10_000;
  let record;
  do {
    const response = await server.inject({ method: "GET", url: `/api/files/${fileId}` });
    record = response.json();
    if (record.scan_status === "ready" || record.scan_status === "error") return record;
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  } while (Date.now() < deadline);
  throw new Error(`scan did not finish: ${JSON.stringify(record)}`);
}

describe("normal PGN scanning", () => {
  it("registers, scans, and persists normal Game records", async () => {
    const { directory, server } = testServer();
    servers.push(server);
    const sourcePath = resolve("tests/fixtures/basic_two_games.pgn");

    const response = await server.inject({
      method: "POST",
      url: "/api/files",
      payload: { path: sourcePath },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().scan_status).toBe("scanning");
    expect(response.json().progress).toMatchObject({
      bytesDone: 0,
      bytesTotal: readFileSync(sourcePath).byteLength,
      gamesFound: 0,
    });

    const record = await waitForReady(server, response.json().id);
    expect(record).toMatchObject({
      name: "basic_two_games.pgn",
      game_count: 2,
      warning_count: 0,
      scan_status: "ready",
      scan_error: null,
      stale: false,
      progress: null,
    });
    expect(record.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    expect(record.size).toBe(readFileSync(sourcePath).byteLength);

    const page = await server.inject({
      method: "GET",
      url: `/api/files/${record.id}/games?offset=0&limit=100`,
    });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({
      total: 2,
      offset: 0,
      limit: 100,
    });
    expect(page.json().games).toEqual([
      expect.objectContaining({
        idx_in_file: 0,
        white: "Alpha, A.",
        black: "Beta, B.",
        event: "Test Open",
        result: "1-0",
      }),
      expect.objectContaining({
        idx_in_file: 1,
        white: "Beta, B.",
        black: "Alpha, A.",
        result: "1/2-1/2",
      }),
    ]);

    const database = new Database(join(directory, "index.sqlite3"));
    try {
      const rows = database
        .prepare(
          "SELECT idx_in_file, offset_start, offset_end, tag_json, has_fen FROM games ORDER BY idx_in_file",
        )
        .all() as Array<{
        idx_in_file: number;
        offset_start: number;
        offset_end: number;
        tag_json: string;
        has_fen: number;
      }>;
      expect(rows).toHaveLength(2);
      expect(JSON.parse(rows[0].tag_json)).toEqual([
        ["Event", "Test Open"],
        ["Site", "Localville"],
        ["Date", "2024.01.15"],
        ["Round", "1"],
        ["White", "Alpha, A."],
        ["Black", "Beta, B."],
        ["Result", "1-0"],
        ["ECO", "C50"],
      ]);
      const source = readFileSync(sourcePath);
      expect(source.subarray(rows[0].offset_start, rows[0].offset_end).toString()).toContain("1-0");
      expect(source.subarray(rows[0].offset_start, rows[0].offset_end).toString()).not.toContain(
        "1/2-1/2",
      );
      expect(rows[0].has_fen).toBe(0);
    } finally {
      database.close();
    }
  });
});
