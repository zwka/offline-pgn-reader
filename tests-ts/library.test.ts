import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { SCHEMA_VERSION, LibraryDatabase } from "../src/database.js";
import { LibraryService } from "../src/library.js";
import { buildServer } from "../src/server.js";

const servers = [] as ReturnType<typeof buildServer>[];
const services: LibraryService[] = [];
const testDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(services.splice(0).map((service) => service.close()));
  testDirectories.splice(0).forEach((directory) => {
    rmSync(directory, { force: true, recursive: true });
  });
});

function testServer() {
  const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-ts-library-"));
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
    record = (await server.inject({ method: "GET", url: `/api/files/${fileId}` })).json();
    if (record.scan_status === "ready" || record.scan_status === "error") return record;
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  } while (Date.now() < deadline);
  throw new Error(`scan did not finish: ${JSON.stringify(record)}`);
}

describe("Library removal and reset", () => {
  it("deletes index records while leaving an external source untouched", async () => {
    const { directory, server } = testServer();
    servers.push(server);
    const sourcePath = join(directory, "external.pgn");
    const sourceBytes = readFileSync(resolve("tests/fixtures/basic_two_games.pgn"));
    writeFileSync(sourcePath, sourceBytes);

    const registered = await server.inject({
      method: "POST",
      url: "/api/files",
      payload: { path: sourcePath },
    });
    const file = await waitForReady(server, registered.json().id);
    const games = (await server.inject({
      method: "GET",
      url: `/api/files/${file.id}/games`,
    })).json().games;
    expect(games).toHaveLength(2);

    const removed = await server.inject({
      method: "DELETE",
      url: `/api/files/${file.id}`,
    });

    expect(removed.statusCode).toBe(204);
    expect(readFileSync(sourcePath)).toEqual(sourceBytes);
    expect((await server.inject({ method: "GET", url: `/api/files/${file.id}` })).statusCode)
      .toBe(404);
    expect((await server.inject({ method: "GET", url: `/api/files/${file.id}/games` })).statusCode)
      .toBe(404);

    const database = new Database(join(directory, "index.sqlite3"));
    try {
      const counts = database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM files WHERE id=?) AS files,
             (SELECT COUNT(*) FROM games WHERE file_id=?) AS games`,
        )
        .get(file.id, file.id) as { files: number; games: number };
      expect(counts).toEqual({ files: 0, games: 0 });
    } finally {
      database.close();
    }
  });

  it("rejects reset for an active scan and recreates the versioned schema", async () => {
    const { directory, server } = testServer();
    servers.push(server);
    const sourcePath = join(directory, "reset-source.pgn");
    const sourceBytes = Buffer.from('[Event "Reset source"]\n\n1. e4 *\n', "utf8");
    writeFileSync(sourcePath, sourceBytes);

    const registered = await server.inject({
      method: "POST",
      url: "/api/files",
      payload: { path: sourcePath },
    });
    const file = await waitForReady(server, registered.json().id);

    const database = new Database(join(directory, "index.sqlite3"));
    try {
      database.prepare("UPDATE files SET scan_status='scanning' WHERE id=?").run(file.id);
    } finally {
      database.close();
    }

    const blocked = await server.inject({ method: "POST", url: "/api/admin/reset" });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ detail: "cannot reset while a scan is running" });

    const repairedStatus = new Database(join(directory, "index.sqlite3"));
    try {
      repairedStatus.prepare("UPDATE files SET scan_status='ready' WHERE id=?").run(file.id);
    } finally {
      repairedStatus.close();
    }

    const reset = await server.inject({ method: "POST", url: "/api/admin/reset" });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ status: "reset" });
    expect(await server.inject({ method: "GET", url: "/api/files" }).then((response) => response.json()))
      .toEqual([]);
    expect(readFileSync(sourcePath)).toEqual(sourceBytes);

    const recreated = new Database(join(directory, "index.sqlite3"));
    try {
      const version = recreated
        .prepare("SELECT value FROM meta WHERE key='schema_version'")
        .get() as { value: string };
      expect(version.value).toBe(String(SCHEMA_VERSION));
      expect(recreated.prepare("SELECT COUNT(*) AS count FROM files").get()).toEqual({ count: 0 });
      expect(recreated.prepare("SELECT COUNT(*) AS count FROM games").get()).toEqual({ count: 0 });
    } finally {
      recreated.close();
    }
  });

  it("uses the same protection for source removal and service reset", () => {
    const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-ts-library-service-"));
    testDirectories.push(directory);
    const service = new LibraryService(
      new LibraryDatabase(join(directory, "index.sqlite3")),
      [],
      join(directory, "library"),
    );
    services.push(service);
    const sourcePath = join(directory, "active.pgn");
    writeFileSync(sourcePath, '[Event "Active"]\n\n1. e4 *\n', "utf8");
    const file = service.registerFile(sourcePath);

    expect(() => service.removeFile(file.id)).toThrowError(
      "cannot remove file while a scan is running",
    );
    expect(() => service.resetIndex()).toThrowError("cannot reset while a scan is running");
  });
});
