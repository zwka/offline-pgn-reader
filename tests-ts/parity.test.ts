import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";
import type { GameDocument } from "../src/wire.js";
import { scanPgn } from "../src/scanner.js";

const fixtureRoot = resolve("tests/fixtures");
const manifestPath = join(fixtureRoot, "parity_manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { sources: string[] };
const errorContract = JSON.parse(
  readFileSync(join(fixtureRoot, "error_contract.json"), "utf8"),
) as Record<string, { status: number; body: Record<string, string> }>;
const testDirectories: string[] = [];
const servers: ReturnType<typeof buildServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  testDirectories.splice(0).forEach((directory) => {
    rmSync(directory, { force: true, recursive: true });
  });
});

describe("Python and TypeScript compatibility", () => {
  it("matches shared source, SQLite, wire, and document fixtures", async () => {
    const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-parity-"));
    testDirectories.push(directory);
    const typeScriptDataDir = join(directory, "typescript");
    const pythonDataDir = join(directory, "python");
    const typeScriptDbPath = join(typeScriptDataDir, "index.sqlite3");
    const server = buildServer({
      dbPath: typeScriptDbPath,
      watchDirs: [],
      uploadDir: join(typeScriptDataDir, "library"),
    });
    servers.push(server);

    const typeScriptSnapshot = await snapshotTypeScript(server, typeScriptDbPath);
    const pythonSnapshot = runPythonOracle(pythonDataDir);

    expect(typeScriptSnapshot).toEqual(pythonSnapshot);
    expect(typeScriptSnapshot.database.schemaVersion).toBe(1);
    expect(typeScriptSnapshot.wire.health).toEqual({
      status: 200,
      body: { status: "ok", version: "1.1.0", db: true },
    });
    for (const [name, expected] of Object.entries(errorContract)) {
      expect(typeScriptSnapshot.errors[name]).toEqual(expected);
    }
  }, 30_000);
});

async function snapshotTypeScript(
  server: ReturnType<typeof buildServer>,
  dbPath: string,
): Promise<ParitySnapshot> {
  const sources: SourceSnapshot[] = [];
  for (const name of manifest.sources) {
    sources.push(await snapshotSource(server, resolve(fixtureRoot, name), name));
  }

  return {
    wire: {
      health: jsonResponse(await server.inject({ method: "GET", url: "/api/health" })),
      notFound: jsonResponse(await server.inject({ method: "GET", url: "/api/missing" })),
    },
    errors: {
      missingFile: jsonResponse(await server.inject({ method: "GET", url: "/api/files/999999" })),
      missingGame: jsonResponse(await server.inject({ method: "GET", url: "/api/games/999999" })),
    },
    files: (await server.inject({ method: "GET", url: "/api/files" })).json().map(fileContract),
    sources,
    database: databaseContract(dbPath),
  };
}

async function snapshotSource(
  server: ReturnType<typeof buildServer>,
  path: string,
  name: string,
): Promise<SourceSnapshot> {
  const scan = [] as ScanRecord[];
  for await (const game of scanPgn(path)) {
    scan.push({
      idxInFile: game.idxInFile,
      offsetStart: game.offsetStart,
      offsetEnd: game.offsetEnd,
      headers: game.headers,
      warning: game.warning,
    });
  }

  const registered = await server.inject({
    method: "POST",
    url: "/api/files",
    payload: { path },
  });
  expect(registered.statusCode).toBe(201);
  const fileId = registered.json().id as number;
  const file = await waitForReady(server, fileId);
  const pageResponse = await server.inject({
    method: "GET",
    url: `/api/files/${fileId}/games?limit=500`,
  });
  expect(pageResponse.statusCode).toBe(200);
  const page = pageResponse.json();
  const documents: GameDocument[] = [];
  const tags: unknown[] = [];
  const sources: string[] = [];
  for (const game of page.games as Array<{ id: number }>) {
    const documentResponse = await server.inject({
      method: "GET",
      url: `/api/games/${game.id}`,
    });
    const tagResponse = await server.inject({
      method: "GET",
      url: `/api/games/${game.id}/tags`,
    });
    const sourceResponse = await server.inject({
      method: "GET",
      url: `/api/games/${game.id}/pgn`,
    });
    expect(documentResponse.statusCode).toBe(200);
    expect(tagResponse.statusCode).toBe(200);
    expect(sourceResponse.statusCode).toBe(200);
    documents.push(canonicalDocument(documentResponse.json() as GameDocument));
    tags.push(tagResponse.json());
    sources.push(sourceResponse.body);
  }

  return {
    name,
    scan,
    file: fileContract(file),
    page,
    documents,
    tags,
    sources,
  };
}

async function waitForReady(
  server: ReturnType<typeof buildServer>,
  fileId: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await server.inject({ method: "GET", url: `/api/files/${fileId}` });
    expect(response.statusCode).toBe(200);
    const file = response.json() as Record<string, unknown>;
    if (file.scan_status === "ready") return file;
    if (file.scan_status === "error") throw new Error(`TypeScript scan failed: ${JSON.stringify(file)}`);
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  }
  throw new Error(`TypeScript scan did not finish for file ${fileId}`);
}

function runPythonOracle(dataDir: string): ParitySnapshot {
  const python = process.env.PGNREADER_PYTHON ?? ".venv/bin/python";
  const result = spawnSync(
    python,
    [
      "tests/parity_oracle.py",
      "--fixture-root",
      fixtureRoot,
      "--manifest",
      manifestPath,
      "--data-dir",
      dataDir,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: process.cwd() },
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Python parity oracle failed (status ${result.status}):\n${result.stderr}\n${result.stdout}`,
    );
  }
  return JSON.parse(result.stdout) as ParitySnapshot;
}

function fileContract(record: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    "id",
    "path",
    "name",
    "size",
    "mtime_ns",
    "fingerprint",
    "game_count",
    "warning_count",
    "scan_status",
    "scan_error",
    "exists",
    "stale",
    "progress",
  ];
  return Object.fromEntries(keys.map((key) => [key, record[key]]));
}

function canonicalDocument(document: GameDocument): GameDocument {
  return {
    ...document,
    warnings: canonicalWarnings(document.warnings),
    nodes: document.nodes.map((node) => ({
      ...node,
      comment: normalizeComment(node.comment),
      startingComment: normalizeComment(node.startingComment),
    })),
  };
}

function canonicalWarnings(warnings: string[]): string[] {
  return [...new Set(warnings.map((warning) => {
    if (
      warning.includes("unrecognized movetext token") ||
      warning.includes("could not parse PGN tree") ||
      warning.includes("could not parse move")
    ) {
      return "malformed movetext";
    }
    return warning;
  }))].sort();
}

function normalizeComment(comment: string): string {
  return comment.replace(/[\r\n]+/g, " ");
}

function jsonResponse(response: { statusCode: number; json(): unknown }): JsonResponse {
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

function databaseContract(path: string): DatabaseSnapshot {
  const database = new Database(path);
  try {
    const tables = (database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>).map(({ name }) => name);
    const columns = Object.fromEntries(tables.map((table) => [
      table,
      (database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
        .map(({ name }) => name),
    ]));
    const files = database.prepare(
      "SELECT id, path, name, size, mtime_ns, fingerprint, game_count, " +
        "warning_count, scan_status, scan_error FROM files ORDER BY id",
    ).all();
    const games = (database.prepare(
      "SELECT id, file_id, idx_in_file, offset_start, offset_end, event, site, " +
        "date, round, white, black, result, eco, opening, has_fen, tag_json, warning " +
        "FROM games ORDER BY file_id, idx_in_file",
    ).all() as Array<Record<string, unknown>>).map((game) => ({
      ...game,
      tag_json: JSON.parse(game.tag_json as string),
    }));
    const schemaVersion = (database
      .prepare("SELECT value FROM meta WHERE key='schema_version'")
      .get() as { value: string }).value;
    return {
      schemaVersion: Number(schemaVersion),
      tables,
      columns,
      files,
      games,
    };
  } finally {
    database.close();
  }
}

type ScanRecord = {
  idxInFile: number;
  offsetStart: number;
  offsetEnd: number;
  headers: Array<[string, string]>;
  warning: string | null;
};

type SourceSnapshot = {
  name: string;
  scan: ScanRecord[];
  file: Record<string, unknown>;
  page: Record<string, unknown>;
  documents: GameDocument[];
  tags: unknown[];
  sources: string[];
};

type JsonResponse = {
  status: number;
  body: Record<string, unknown>;
};

type DatabaseSnapshot = {
  schemaVersion: number;
  tables: string[];
  columns: Record<string, string[]>;
  files: unknown[];
  games: unknown[];
};

type ParitySnapshot = {
  wire: {
    health: JsonResponse;
    notFound: JsonResponse;
  };
  errors: Record<string, JsonResponse>;
  files: Record<string, unknown>[];
  sources: SourceSnapshot[];
  database: DatabaseSnapshot;
};
