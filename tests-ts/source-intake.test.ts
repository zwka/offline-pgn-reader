import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

function testServer(watchDirectory: string) {
  const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-ts-"));
  testDirectories.push(directory);
  return buildServer({
    dbPath: join(directory, "index.sqlite3"),
    watchDirs: [watchDirectory],
  });
}

function sourceFixture(directory: string) {
  const nested = join(directory, "nested");
  mkdirSync(nested, { recursive: true });
  const source = join(nested, "study.pgn");
  writeFileSync(source, '[Event "Discovery"]\n\n1. e4 *\n', "utf8");
  writeFileSync(join(directory, "ignore.txt"), "not a PGN", "utf8");
  return source;
}

describe("PGN source intake", () => {
  it("discovers recursive PGN sources with their registration state", async () => {
    const watchDirectory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-watch-"));
    testDirectories.push(watchDirectory);
    const source = sourceFixture(watchDirectory);
    const server = testServer(watchDirectory);
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/api/discover" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        path: realpathSync(source),
        name: "study.pgn",
        size: readFileSync(source).byteLength,
        registered: false,
      },
    ]);
  });

  it("registers a source once and returns the compatible FileRecord", async () => {
    const watchDirectory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-watch-"));
    testDirectories.push(watchDirectory);
    const source = sourceFixture(watchDirectory);
    const server = testServer(watchDirectory);
    servers.push(server);

    const first = await server.inject({
      method: "POST",
      url: "/api/files",
      payload: { path: source },
    });
    const second = await server.inject({
      method: "POST",
      url: "/api/files",
      payload: { path: join(watchDirectory, "nested", "..", "nested", "study.pgn") },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const record = first.json();
    expect(second.json()).toEqual(record);
    expect(record).toMatchObject({
      path: realpathSync(source),
      name: "study.pgn",
      size: 0,
      mtime_ns: 0,
      fingerprint: "",
      game_count: 0,
      warning_count: 0,
      scan_status: "pending",
      scan_error: null,
      scanned_at: null,
      exists: true,
      stale: false,
      progress: null,
    });
    expect(record.id).toEqual(expect.any(Number));
    expect(await server.inject({ method: "GET", url: "/api/files" }).then((res) => res.json()))
      .toHaveLength(1);
    expect((await server.inject({ method: "GET", url: "/api/discover" })).json())
      .toContainEqual({
        path: realpathSync(source),
        name: "study.pgn",
        size: readFileSync(source).byteLength,
        registered: true,
      });
  });

  it("rejects missing and non-PGN sources with the error envelope", async () => {
    const watchDirectory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-watch-"));
    testDirectories.push(watchDirectory);
    const source = sourceFixture(watchDirectory);
    const server = testServer(watchDirectory);
    servers.push(server);

    const missing = await server.inject({
      method: "POST",
      url: "/api/files",
      payload: { path: join(watchDirectory, "missing.pgn") },
    });
    const invalid = await server.inject({
      method: "POST",
      url: "/api/files",
      payload: { path: join(watchDirectory, "ignore.txt") },
    });

    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ detail: expect.stringContaining("not a file") });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toEqual({ detail: expect.stringContaining("not a .pgn file") });
  });

  it("rejects a non-string path without coercing the request body", async () => {
    const watchDirectory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-watch-"));
    testDirectories.push(watchDirectory);
    const server = testServer(watchDirectory);
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/files",
      payload: { path: 42 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toContain("must be string");
  });
});
