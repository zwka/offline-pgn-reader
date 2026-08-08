import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteIndex } from "../src/index.js";
import { LibraryService } from "../src/library.js";
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

async function waitForServiceReady(service: LibraryService, fileId: number) {
  const deadline = Date.now() + 10_000;
  let record = service.getFile(fileId);
  do {
    record = service.getFile(fileId);
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

  it("indexes difficult source bytes, warnings, and later game records", async () => {
    const { directory, server } = testServer();
    servers.push(server);
    const corpus = JSON.parse(
      readFileSync(join(resolve("tests/fixtures"), "scan_corpus.json"), "utf8"),
    ) as {
      cases: Array<{
        name: string;
        source?: string;
        games?: Array<{ idxInFile: number; offsetStart: number; offsetEnd: number }>;
      }>;
    };
    const difficult = corpus.cases.find((corpusCase) => corpusCase.name === "difficult-source");
    if (!difficult?.source || !difficult.games) throw new Error("difficult scan corpus case is missing");
    const sourcePath = join(directory, "difficult-source.pgn");
    const source = Buffer.from(difficult.source, "utf8");
    writeFileSync(sourcePath, source);

    const response = await server.inject({
      method: "POST",
      url: "/api/files",
      payload: { path: sourcePath },
    });
    const record = await waitForReady(server, response.json().id);
    expect(record).toMatchObject({ game_count: 5, warning_count: 1, scan_status: "ready" });

    const page = await server.inject({
      method: "GET",
      url: `/api/files/${record.id}/games?offset=0&limit=100`,
    });
    expect(page.json().games).toEqual([
      expect.objectContaining({ idx_in_file: 0, event: "", warning: "movetext with no tag section" }),
      expect.objectContaining({ idx_in_file: 1, event: "Duplicate final", white: "Final White" }),
      expect.objectContaining({ idx_in_file: 2, event: "Malformed middle" }),
      expect.objectContaining({ idx_in_file: 3, event: "Headers only" }),
      expect.objectContaining({ idx_in_file: 4, event: "After headers", white: "Final game" }),
    ]);

    const warningDocument = await server.inject({
      method: "GET",
      url: `/api/games/${page.json().games[0].id}`,
    });
    expect(warningDocument.statusCode).toBe(200);
    expect(warningDocument.json().warnings).toContain(
      "index warning: movetext with no tag section",
    );

    const database = new Database(join(directory, "index.sqlite3"));
    try {
      const rows = database
        .prepare("SELECT idx_in_file, offset_start, offset_end FROM games ORDER BY idx_in_file")
        .all() as Array<{ idx_in_file: number; offset_start: number; offset_end: number }>;
      expect(rows).toHaveLength(difficult.games.length);
      expect(rows.map(({ idx_in_file, offset_start, offset_end }) => ({
        idxInFile: idx_in_file,
        offsetStart: offset_start,
        offsetEnd: offset_end,
      }))).toEqual(difficult.games.map(({ idxInFile, offsetStart, offsetEnd }) => ({
        idxInFile,
        offsetStart,
        offsetEnd,
      })));
      expect(rows.map(({ offset_start, offset_end }) =>
        source.subarray(offset_start, offset_end).toString("utf8"))).toEqual([
        ...difficult.games.map(({ offsetStart, offsetEnd }) =>
          source.subarray(offsetStart, offsetEnd).toString("utf8")),
      ]);
    } finally {
      database.close();
    }
  });

  it("keeps the HTTP force default distinct from the internal skip default", async () => {
    const { server } = testServer();
    servers.push(server);
    const sourcePath = resolve("tests/fixtures/basic_two_games.pgn");

    const registered = await server.inject({
      method: "POST",
      url: "/api/files",
      payload: { path: sourcePath },
    });
    const fileId = registered.json().id;
    await waitForReady(server, fileId);

    const skipped = await server.inject({
      method: "POST",
      url: `/api/files/${fileId}/rescan?force=false`,
    });
    expect(skipped.statusCode).toBe(200);
    expect(skipped.json().scanStarted).toBe(false);

    const forced = await server.inject({
      method: "POST",
      url: `/api/files/${fileId}/rescan`,
    });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().scanStarted).toBe(true);
    expect((await waitForReady(server, fileId)).scan_status).toBe("ready");
  });

  it("keeps the internal startScan default non-forced", async () => {
    const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-ts-"));
    testDirectories.push(directory);
    const service = new LibraryService(
      new SqliteIndex(join(directory, "index.sqlite3")),
      [],
      join(directory, "library"),
    );
    const sourcePath = resolve("tests/fixtures/basic_two_games.pgn");

    try {
      const registered = service.registerFile(sourcePath);
      expect((await waitForServiceReady(service, registered.id)).scan_status).toBe("ready");
      expect(service.startScan(registered.id)).toBe(false);
      expect(service.startScan(registered.id, true)).toBe(true);
      expect((await waitForServiceReady(service, registered.id)).scan_status).toBe("ready");
    } finally {
      await service.close();
    }
  });

  it("recovers an interrupted scan as pending before it can be retried", async () => {
    const { directory, server } = testServer();
    servers.push(server);
    const sourcePath = resolve("tests/fixtures/basic_two_games.pgn");
    const registered = await server.inject({
      method: "POST",
      url: "/api/files",
      payload: { path: sourcePath },
    });
    const fileId = registered.json().id;
    await waitForReady(server, fileId);

    const database = new Database(join(directory, "index.sqlite3"));
    try {
      database.prepare("UPDATE files SET scan_status='scanning' WHERE id=?").run(fileId);
    } finally {
      database.close();
    }

    const oldServerIndex = servers.indexOf(server);
    await server.close();
    if (oldServerIndex >= 0) servers.splice(oldServerIndex, 1);

    const restarted = buildServer({
      dbPath: join(directory, "index.sqlite3"),
      watchDirs: [],
      uploadDir: join(directory, "library"),
    });
    servers.push(restarted);

    const pending = await restarted.inject({ method: "GET", url: `/api/files/${fileId}` });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({ scan_status: "pending", progress: null });

    const retry = await restarted.inject({
      method: "POST",
      url: `/api/files/${fileId}/rescan?force=false`,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().scanStarted).toBe(true);
    expect((await waitForReady(restarted, fileId)).scan_status).toBe("ready");
  });

  it("keeps the previous Index when replacement fails inside its transaction", async () => {
    const { directory, server } = testServer();
    servers.push(server);
    const sourcePath = resolve("tests/fixtures/basic_two_games.pgn");
    const registered = await server.inject({
      method: "POST",
      url: "/api/files",
      payload: { path: sourcePath },
    });
    const fileId = registered.json().id;
    await waitForReady(server, fileId);
    const before = await server.inject({ method: "GET", url: `/api/files/${fileId}/games` });

    const database = new Database(join(directory, "index.sqlite3"));
    try {
      database.exec(
        `CREATE TRIGGER reject_replacement BEFORE INSERT ON games
         WHEN NEW.file_id=${fileId}
         BEGIN SELECT RAISE(ABORT, 'replacement rejected'); END;`,
      );
    } finally {
      database.close();
    }

    const rescan = await server.inject({
      method: "POST",
      url: `/api/files/${fileId}/rescan`,
    });
    expect(rescan.statusCode).toBe(200);
    expect(rescan.json().scanStarted).toBe(true);
    const failed = await waitForReady(server, fileId);
    expect(failed).toMatchObject({
      scan_status: "error",
      scan_error: expect.stringContaining("replacement rejected"),
    });

    const after = await server.inject({ method: "GET", url: `/api/files/${fileId}/games` });
    expect(after.statusCode).toBe(200);
    expect(after.json().games).toEqual(before.json().games);
  });
});
