import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import Database from "better-sqlite3";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";
import { GameDocumentSchema, GamePageSchema, TagPairsSchema } from "../src/wire.js";

const servers = [] as ReturnType<typeof buildServer>[];
const testDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  testDirectories.splice(0).forEach((directory) => {
    rmSync(directory, { force: true, recursive: true });
  });
});

function testServer() {
  const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-ts-games-"));
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

function browseSource(): string {
  return [
    '[Event "First Match"]',
    '[Site "Local"]',
    '[Date "2024.01.01"]',
    '[Round "1"]',
    '[White "White One"]',
    '[Black "Black One"]',
    '[Result "1-0"]',
    '[ECO "C20"]',
    '[Opening "King Pawn"]',
    "",
    "1. e4 1-0",
    "",
    '[Event "Second Match"]',
    '[Site "Remote"]',
    '[Date "2024.02.02"]',
    '[Round "2"]',
    '[White "White Two"]',
    '[Black "Black Two"]',
    '[Result "*"]',
    '[ECO "D10"]',
    '[Opening "Queen Pawn"]',
    '[FEN "8/8/8/8/8/8/8/8 w - - 0 1"]',
    '[SetUp "1"]',
    "",
    "1. d4 *",
    "",
    '[Event "Third Match"]',
    '[Site "Local"]',
    '[Date "2024.03.03"]',
    '[Round "3"]',
    '[White "White Three"]',
    '[Black "Black Three"]',
    '[Result "1/2-1/2"]',
    '[ECO "E00"]',
    '[Opening "Catalan"]',
    "",
    "1. Nf3 1/2-1/2",
    "",
  ].join("\n");
}

describe("indexed Game list contract", () => {
  it("returns ordered, paged, searchable records with the agreed wire shape", async () => {
    const { directory, server } = testServer();
    servers.push(server);
    const sourcePath = join(directory, "browse.pgn");
    writeFileSync(sourcePath, browseSource(), "utf8");

    const registered = await server.inject({
      method: "POST",
      url: "/api/files",
      payload: { path: sourcePath },
    });
    expect(registered.statusCode).toBe(201);
    const file = await waitForReady(server, registered.json().id);
    expect(file).toMatchObject({ scan_status: "ready", game_count: 3, warning_count: 0 });

    const defaultPage = await server.inject({
      method: "GET",
      url: `/api/files/${file.id}/games`,
    });
    expect(defaultPage.statusCode).toBe(200);
    const defaultBody = defaultPage.json();
    expect(Value.Check(GamePageSchema, defaultBody)).toBe(true);
    expect(defaultBody).toMatchObject({ total: 3, offset: 0, limit: 100 });
    expect(defaultBody.games.map((game: { idx_in_file: number }) => game.idx_in_file)).toEqual([0, 1, 2]);
    expect(defaultBody.games[0]).toMatchObject({
      idx_in_file: 0,
      event: "First Match",
      site: "Local",
      date: "2024.01.01",
      round: "1",
      white: "White One",
      black: "Black One",
      result: "1-0",
      eco: "C20",
      opening: "King Pawn",
      has_fen: 0,
      warning: null,
    });
    expect(defaultBody.games[0].byte_size).toBeGreaterThan(0);
    expect(defaultBody.games[1]).toMatchObject({ has_fen: 1, warning: null });

    const database = new Database(join(directory, "index.sqlite3"));
    try {
      const row = database
        .prepare("SELECT tag_json FROM games WHERE file_id=? ORDER BY idx_in_file LIMIT 1")
        .get(file.id) as { tag_json: string };
      expect(JSON.parse(row.tag_json)).toEqual([
        ["Event", "First Match"],
        ["Site", "Local"],
        ["Date", "2024.01.01"],
        ["Round", "1"],
        ["White", "White One"],
        ["Black", "Black One"],
        ["Result", "1-0"],
        ["ECO", "C20"],
        ["Opening", "King Pawn"],
      ]);
    } finally {
      database.close();
    }

    const page = await server.inject({
      method: "GET",
      url: `/api/files/${file.id}/games?offset=1&limit=1`,
    });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ total: 3, offset: 1, limit: 1 });
    expect(page.json().games).toHaveLength(1);
    expect(page.json().games[0]).toMatchObject({ idx_in_file: 1, white: "White Two" });

    const maxPage = await server.inject({
      method: "GET",
      url: `/api/files/${file.id}/games?limit=500`,
    });
    expect(maxPage.statusCode).toBe(200);
    expect(maxPage.json().limit).toBe(500);

    for (const query of [
      "White Two",
      "Black Two",
      "Second Match",
      "Remote",
      "Queen Pawn",
      "D10",
      "2024.02.02",
    ]) {
      const search = await server.inject({
        method: "GET",
        url: `/api/files/${file.id}/games?q=${encodeURIComponent(`  ${query}  `)}`,
      });
      expect(search.statusCode).toBe(200);
      expect(search.json()).toMatchObject({ total: 1, offset: 0, limit: 100 });
      expect(search.json().games[0]).toMatchObject({ idx_in_file: 1 });
    }

    const empty = await server.inject({
      method: "GET",
      url: `/api/files/${file.id}/games?q=not-found`,
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ total: 0, offset: 0, limit: 100, games: [] });
  });

  it("opens a normal GameDocument with main-line nodes and file neighbors", async () => {
    const { directory, server } = testServer();
    servers.push(server);
    const sourcePath = join(directory, "reader.pgn");
    writeFileSync(
      sourcePath,
      [
        '[Event "Reader Match"]',
        '[Site "Local"]',
        '[Date "2024.01.01"]',
        '[Round "1"]',
        '[White "White One"]',
        '[Black "Black One"]',
        '[Result "1-0"]',
        "",
        "1. e4 e5 2. Nf3 Nc6 3. Bc4 1-0",
        "",
        '[Event "Neighbor"]',
        '[Result "*"]',
        "",
        "1. d4 *",
      ].join("\n"),
      "utf8",
    );

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

    const response = await server.inject({
      method: "GET",
      url: `/api/games/${games[0].id}`,
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(Value.Check(GameDocumentSchema, body)).toBe(true);
    expect(body).toMatchObject({
      gameId: games[0].id,
      fileId: file.id,
      fileName: "reader.pgn",
      idxInFile: 0,
      rootId: 0,
      result: "1-0",
      neighbors: { prev: null, next: games[1].id },
    });
    expect(body.headers).toEqual([
      ["Event", "Reader Match"],
      ["Site", "Local"],
      ["Date", "2024.01.01"],
      ["Round", "1"],
      ["White", "White One"],
      ["Black", "Black One"],
      ["Result", "1-0"],
    ]);
    expect(body.nodes[0]).toMatchObject({
      id: 0,
      parentId: null,
      san: null,
      uci: null,
      children: [1],
    });
    expect(body.nodes.slice(1).map((node: { san: string }) => node.san)).toEqual([
      "e4",
      "e5",
      "Nf3",
      "Nc6",
      "Bc4",
    ]);
  });

  it("opens recursive variations and FEN-start documents through the API", async () => {
    const { directory, server } = testServer();
    servers.push(server);
    const sourcePath = join(directory, "variation-fen.pgn");
    const variations = readFileSync(resolve("tests/fixtures/variations.pgn"), "utf8").trim();
    const fenStart = readFileSync(resolve("tests/fixtures/fen_start.pgn"), "utf8").trim();
    writeFileSync(sourcePath, `${variations}\n\n${fenStart}\n`, "utf8");

    const registered = await server.inject({
      method: "POST",
      url: "/api/files",
      payload: { path: sourcePath },
    });
    const file = await waitForReady(server, registered.json().id);
    expect(file).toMatchObject({ scan_status: "ready", game_count: 2, warning_count: 0 });

    const games = (await server.inject({
      method: "GET",
      url: `/api/files/${file.id}/games`,
    })).json().games;
    const variationResponse = await server.inject({
      method: "GET",
      url: `/api/games/${games[0].id}`,
    });
    const variationDocument = variationResponse.json();
    expect(variationResponse.statusCode).toBe(200);
    expect(Value.Check(GameDocumentSchema, variationDocument)).toBe(true);
    expect(variationDocument.nodes[1].children).toEqual([2, 9, 17]);
    expect(variationDocument.nodes[12].children).toEqual([13, 14]);
    expect(variationDocument.nodes[17]).toMatchObject({
      parentId: 1,
      san: "e6",
      uci: "e7e6",
    });

    const fenResponse = await server.inject({
      method: "GET",
      url: `/api/games/${games[1].id}`,
    });
    const fenDocument = fenResponse.json();
    expect(fenResponse.statusCode).toBe(200);
    expect(Value.Check(GameDocumentSchema, fenDocument)).toBe(true);
    expect(fenDocument.nodes[0].fen).toBe(
      "1k6/1P3R2/8/8/8/8/r7/2K5 w - - 0 1",
    );
    expect(fenDocument.nodes[1]).toMatchObject({ san: "Rf8+", uci: "f7f8", parentId: 0 });
  });

  it("serves decoded source text and ordered duplicate tag pairs", async () => {
    const { directory, server } = testServer();
    servers.push(server);
    const source = [
      '[Event "First event"]',
      '[Event "Second event"]',
      '[White "First white"]',
      '[White "Second white"]',
      '[Note "deja vu"]',
      '[Result "*"]',
      "",
      "1. e4 *",
      "",
    ].join("\n");
    const sourcePath = join(directory, "source-and-tags.pgn");
    writeFileSync(sourcePath, source, "utf8");

    const registered = await server.inject({
      method: "POST",
      url: "/api/files",
      payload: { path: sourcePath },
    });
    const file = await waitForReady(server, registered.json().id);
    const game = (await server.inject({
      method: "GET",
      url: `/api/files/${file.id}/games`,
    })).json().games[0];

    const sourceResponse = await server.inject({
      method: "GET",
      url: `/api/games/${game.id}/pgn`,
    });
    expect(sourceResponse.statusCode).toBe(200);
    expect(sourceResponse.headers["content-type"]).toMatch(/^text\/plain; charset=utf-8/);
    expect(sourceResponse.body).toBe(source.trimEnd());

    const tagsResponse = await server.inject({
      method: "GET",
      url: `/api/games/${game.id}/tags`,
    });
    const tags = tagsResponse.json();
    expect(tagsResponse.statusCode).toBe(200);
    expect(Value.Check(TagPairsSchema, tags)).toBe(true);
    expect(tags).toEqual([
      ["Event", "First event"],
      ["Event", "Second event"],
      ["White", "First white"],
      ["White", "Second white"],
      ["Note", "deja vu"],
      ["Result", "*"],
    ]);

    const document = (await server.inject({
      method: "GET",
      url: `/api/games/${game.id}`,
    })).json();
    expect(Value.Check(GameDocumentSchema, document)).toBe(true);
    expect(document.headers).toEqual(tags);
  });

  it("serves comments, NAGs, and graphics through the typed GameDocument wire", async () => {
    const { server } = testServer();
    servers.push(server);
    const sourcePath = resolve("tests/fixtures/graphics.pgn");

    const registered = await server.inject({
      method: "POST",
      url: "/api/files",
      payload: { path: sourcePath },
    });
    const file = await waitForReady(server, registered.json().id);
    const game = (await server.inject({
      method: "GET",
      url: `/api/files/${file.id}/games`,
    })).json().games[0];

    const response = await server.inject({ method: "GET", url: `/api/games/${game.id}` });
    const document = response.json();
    const bySan = new Map(
      document.nodes.filter((node: { san: string | null }) => node.san)
        .map((node: { san: string }) => [node.san, node]),
    );

    expect(response.statusCode).toBe(200);
    expect(Value.Check(GameDocumentSchema, document)).toBe(true);
    expect(document.nodes[document.rootId]).toMatchObject({
      comment: "Intro with shapes.",
      arrows: [{ from: "d2", to: "d4", color: "green" }],
      highlights: [
        { square: "d4", color: "green" },
        { square: "e5", color: "red" },
      ],
    });
    expect(bySan.get("e4")).toMatchObject({
      comment: "King's pawn.",
      arrows: [
        { from: "e2", to: "e4", color: "green" },
        { from: "d7", to: "d5", color: "red" },
      ],
      highlights: [{ square: "e4", color: "yellow" }],
    });
    expect(bySan.get("c5")).toMatchObject({ highlights: [{ square: "c5", color: "blue" }] });
    expect(document.warnings).toEqual([]);
  });

  it("rejects invalid list bounds instead of silently changing the request", async () => {
    const { server } = testServer();
    servers.push(server);
    const sourcePath = join(testDirectories.at(-1)!, "bounds.pgn");
    writeFileSync(sourcePath, '[Event "Bounds"]\n\n1. e4 *\n', "utf8");
    const registered = await server.inject({
      method: "POST",
      url: "/api/files",
      payload: { path: sourcePath },
    });
    const file = await waitForReady(server, registered.json().id);

    for (const url of [
      `/api/files/${file.id}/games?limit=0`,
      `/api/files/${file.id}/games?limit=501`,
      `/api/files/${file.id}/games?offset=-1`,
      `/api/files/${file.id}/games?q=${"x".repeat(201)}`,
    ]) {
      const response = await server.inject({ method: "GET", url });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ detail: expect.any(String) });
    }
  });
});
