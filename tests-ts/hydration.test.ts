import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { hydrateGame } from "../src/hydration.js";

describe("main-line GameDocument hydration", () => {
  it("keeps ordered headers and builds the server-positioned main line", () => {
    const source = readFileSync(resolve("tests/fixtures/basic_two_games.pgn"));
    const secondGame = source.subarray(source.indexOf(Buffer.from("[Event \"Test Open\"]"), 1));
    const document = hydrateGame(secondGame);

    expect(document.headers).toEqual([
      ["Event", "Test Open"],
      ["Site", "Localville"],
      ["Date", "2024.01.16"],
      ["Round", "2"],
      ["White", "Beta, B."],
      ["Black", "Alpha, A."],
      ["Result", "1/2-1/2"],
    ]);
    expect(document.result).toBe("1/2-1/2");
    expect(document.rootId).toBe(0);
    expect(document.nodes).toHaveLength(9);
    expect(document.nodes.map((node) => node.san)).toEqual([
      null,
      "d4",
      "d5",
      "c4",
      "e6",
      "Nc3",
      "Nf6",
      "Bg5",
      "Be7",
    ]);
  });

  it("preserves SAN, UCI, FEN, move numbers, colors, and child ordering", () => {
    const source = Buffer.from(
      [
        '[Event "Normal"]',
        '[White "White"]',
        '[Black "Black"]',
        '[Result "1-0"]',
        "",
        "1. e4 e5 2. Nf3 Nc6 3. Bc4 1-0",
      ].join("\n"),
    );
    const document = hydrateGame(source);
    const moves = document.nodes.slice(1);

    expect(moves.map((node) => node.san)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bc4"]);
    expect(moves.map((node) => node.uci)).toEqual([
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1c4",
    ]);
    expect(moves.map((node) => [node.moveNumber, node.color])).toEqual([
      [1, "w"],
      [1, "b"],
      [2, "w"],
      [2, "b"],
      [3, "w"],
    ]);
    expect(document.nodes[0].fen).toBe(
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    );
    expect(moves[0].fen).toBe(
      "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    );
    expect(moves.at(-1)?.fen).toBe(
      "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3",
    );
    expect(document.nodes.map((node) => node.children)).toEqual([
      [1],
      [2],
      [3],
      [4],
      [5],
      [],
    ]);
    expect(document.warnings).toEqual([]);
  });

  it("parses BOM-prefixed spans and compact move numbers without warnings", () => {
    const source = Buffer.from(
      [
        '\ufeff[Event "Portable"]',
        '[Result "*"]',
        "",
        "1.e4 e5 2.Nf3 *",
      ].join("\n"),
    );

    const document = hydrateGame(source);

    expect(document.headers).toEqual([["Event", "Portable"], ["Result", "*"]]);
    expect(document.nodes.slice(1).map((node) => node.san)).toEqual(["e4", "e5", "Nf3"]);
    expect(document.warnings).toEqual([]);
    expect(document.source.startsWith("\ufeff")).toBe(true);
  });
});
