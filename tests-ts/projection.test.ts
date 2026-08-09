import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { hydrateGame } from "../src/hydration.js";
import {
  decodeTagPairs,
  projectErrorResponse,
  projectFileRow,
  projectGameDocument,
  projectGameRow,
  ServiceError,
} from "../src/projection.js";
import type { IndexFile, IndexGame, IndexGameRow } from "../src/index.js";
import { sourceFingerprint, sourceStats } from "../src/source.js";

const sourcePath = resolve("tests/fixtures/basic_two_games.pgn");

function storedGame(): IndexGameRow {
  return {
    id: 17,
    file_id: 3,
    idx_in_file: 2,
    offset_start: 10,
    offset_end: 137,
    event: "Stored event",
    site: "Stored site",
    date: "2024.03.03",
    round: "2",
    white: "White",
    black: "Black",
    result: "1-0",
    eco: "C20",
    opening: "King Pawn",
    has_fen: 0,
    tag_json: JSON.stringify([["Event", "Stored event"], ["Event", "Duplicate"]]),
    warning: "stored warning",
  };
}

function hydratedGameRow(): IndexGame {
  return {
    ...storedGame(),
    file_path: sourcePath,
    file_name: "basic_two_games.pgn",
    file_scan_status: "ready",
    file_fingerprint: sourceFingerprint(sourcePath),
  };
}

describe("reader projection", () => {
  it("translates stored file and Game rows without changing wire casing", () => {
    const stats = sourceStats(sourcePath);
    const file: IndexFile = {
      id: 3,
      path: sourcePath,
      name: "basic_two_games.pgn",
      size: stats.size,
      mtime_ns: Number(stats.mtimeNs),
      fingerprint: sourceFingerprint(sourcePath),
      game_count: 2,
      warning_count: 0,
      scan_status: "ready",
      scan_error: null,
      scanned_at: "2026-08-09 00:00:00",
    };

    expect(projectFileRow(file)).toMatchObject({
      id: 3,
      path: sourcePath,
      name: "basic_two_games.pgn",
      game_count: 2,
      warning_count: 0,
      scan_status: "ready",
      exists: true,
      stale: false,
      progress: null,
    });
    expect(projectGameRow(storedGame())).toEqual({
      id: 17,
      idx_in_file: 2,
      event: "Stored event",
      site: "Stored site",
      date: "2024.03.03",
      round: "2",
      white: "White",
      black: "Black",
      result: "1-0",
      eco: "C20",
      opening: "King Pawn",
      has_fen: 0,
      warning: "stored warning",
      byte_size: 127,
    });
  });

  it("decodes ordered duplicate Tag pairs from stored JSON", () => {
    expect(decodeTagPairs(JSON.stringify([
      ["Event", "First"],
      ["Event", "Second"],
      ["White", "First White"],
    ]))).toEqual([
      ["Event", "First"],
      ["Event", "Second"],
      ["White", "First White"],
    ]);
    expect(decodeTagPairs("not-json")).toEqual([]);
  });

  it("assembles hydrated payload identity and neighboring Game records", () => {
    const source = readFileSync(resolve("tests/fixtures/basic_two_games.pgn"));
    const payload = hydrateGame(source.subarray(0, source.indexOf(Buffer.from("[Event \"Test Open\"]"), 1)));
    const document = projectGameDocument(hydratedGameRow(), payload, { prev: 16, next: 18 });

    expect(document).toMatchObject({
      gameId: 17,
      fileId: 3,
      fileName: "basic_two_games.pgn",
      idxInFile: 2,
      rootId: 0,
      neighbors: { prev: 16, next: 18 },
    });
    expect(document.headers).toEqual(payload.headers);
    expect(document.nodes).toEqual(payload.nodes);
    expect(document.source).toBe(payload.source);
  });

  it("projects errors into the shared status and detail envelope", () => {
    expect(projectErrorResponse(new Error("unexpected failure"))).toEqual({
      statusCode: 500,
      body: { detail: "Internal Server Error" },
    });
    expect(projectErrorResponse(new ServiceError("source changed", 409))).toEqual({
      statusCode: 409,
      body: { detail: "source changed" },
    });
  });
});
