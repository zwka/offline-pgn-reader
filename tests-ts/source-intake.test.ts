import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";
import { FileRecordSchema } from "../src/wire.js";

const servers = [] as ReturnType<typeof buildServer>[];
const testDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  testDirectories.splice(0).forEach((directory) => {
    rmSync(directory, { force: true, recursive: true });
  });
});

function testServer(watchDirectory: string, uploadDir?: string) {
  const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-ts-"));
  testDirectories.push(directory);
  return buildServer({
    dbPath: join(directory, "index.sqlite3"),
    watchDirs: [watchDirectory],
    uploadDir: uploadDir ?? join(directory, "library"),
  });
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

function multipartUpload(filename: string, content: Buffer, fieldName = "file") {
  const boundary = "offline-pgn-reader-test-boundary";
  return {
    method: "POST" as const,
    url: "/api/files/upload",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
        "Content-Type: application/octet-stream\r\n\r\n",
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function emptyMultipart() {
  const boundary = "offline-pgn-reader-test-boundary";
  return {
    method: "POST" as const,
    url: "/api/files/upload",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}--\r\n`),
  };
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

  it("registers a source once and returns a scanning FileRecord", async () => {
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
    const initial = first.json();
    expect(second.json().id).toBe(initial.id);
    const record = await waitForReady(server, initial.id);
    expect(record).toMatchObject({
      path: realpathSync(source),
      name: "study.pgn",
      size: readFileSync(source).byteLength,
      game_count: 1,
      warning_count: 0,
      scan_status: "ready",
      scan_error: null,
      exists: true,
      stale: false,
      progress: null,
    });
    expect(record.mtime_ns).toBeGreaterThan(0);
    expect(record.fingerprint).toMatch(/^[0-9a-f]{40}$/);
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

  it("uploads source bytes into the managed Library and scans the copy", async () => {
    const watchDirectory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-watch-"));
    const uploadDirectory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-upload-"));
    testDirectories.push(watchDirectory, uploadDirectory);
    const server = testServer(watchDirectory, uploadDirectory);
    servers.push(server);
    const content = Buffer.from('[Event "Uploaded"]\r\n\r\n1. e4 *\r\n', "utf8");

    const response = await server.inject(multipartUpload("study.pgn", content));

    expect(response.statusCode).toBe(201);
    const initial = response.json();
    expect(Value.Check(FileRecordSchema, initial)).toBe(true);
    const record = await waitForReady(server, initial.id);
    expect(record).toMatchObject({
      path: join(realpathSync(uploadDirectory), "study.pgn"),
      name: "study.pgn",
      size: content.byteLength,
      game_count: 1,
      warning_count: 0,
      scan_status: "ready",
      scan_error: null,
      exists: true,
      stale: false,
      progress: null,
    });
    expect(readFileSync(record.path)).toEqual(content);
  });

  it("normalizes upload names and allocates a suffix for duplicates", async () => {
    const watchDirectory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-watch-"));
    const uploadDirectory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-upload-"));
    testDirectories.push(watchDirectory, uploadDirectory);
    const server = testServer(watchDirectory, uploadDirectory);
    servers.push(server);
    const content = Buffer.from("uploaded bytes", "utf8");

    const first = await server.inject(multipartUpload("../Chapter: One", content));
    const second = await server.inject(multipartUpload("../Chapter: One", content));

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      name: "Chapter_ One.pgn",
      path: join(realpathSync(uploadDirectory), "Chapter_ One.pgn"),
    });
    expect(second.json()).toMatchObject({
      name: "Chapter_ One-1.pgn",
      path: join(realpathSync(uploadDirectory), "Chapter_ One-1.pgn"),
    });
    expect(readFileSync(first.json().path)).toEqual(content);
    expect(readFileSync(second.json().path)).toEqual(content);
  });

  it("rejects uploads without the agreed file field", async () => {
    const watchDirectory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-watch-"));
    testDirectories.push(watchDirectory);
    const server = testServer(watchDirectory);
    servers.push(server);

    const wrongField = await server.inject(
      multipartUpload("study.pgn", Buffer.from("bytes"), "source"),
    );
    const missing = await server.inject(emptyMultipart());

    expect(wrongField.statusCode).toBe(400);
    expect(wrongField.json()).toEqual({ detail: expect.stringContaining("file") });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({ detail: expect.stringContaining("file") });
  });
});
