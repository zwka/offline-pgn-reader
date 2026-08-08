import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { hydrateGame } from "../src/hydration.js";

describe("GameDocument hydration", () => {
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

  it("keeps parsing the tree when escape lines surround movetext", () => {
    const document = hydrateGame(readFileSync(resolve("tests/fixtures/escape_lines.pgn")));

    expect(document.nodes.slice(1).map((node) => node.san)).toEqual(["e4", "c5"]);
    expect(document.warnings).toEqual([]);
  });

  it("preserves recursive variation order and flat parent/child ids", () => {
    const document = hydrateGame(readFileSync(resolve("tests/fixtures/variations.pgn")));

    expect(document.nodes.map((node) => node.san)).toEqual([
      null,
      "e4",
      "e5",
      "Nf3",
      "Nc6",
      "Bb5",
      "Nf6",
      "Nxe5",
      "d6",
      "c5",
      "Nf3",
      "d6",
      "c3",
      "Nf6",
      "d5",
      "exd5",
      "Qxd5",
      "e6",
    ]);
    expect(document.nodes.map(({ id, parentId, children }) => ({ id, parentId, children }))).toEqual([
      { id: 0, parentId: null, children: [1] },
      { id: 1, parentId: 0, children: [2, 9, 17] },
      { id: 2, parentId: 1, children: [3] },
      { id: 3, parentId: 2, children: [4, 6] },
      { id: 4, parentId: 3, children: [5] },
      { id: 5, parentId: 4, children: [] },
      { id: 6, parentId: 3, children: [7] },
      { id: 7, parentId: 6, children: [8] },
      { id: 8, parentId: 7, children: [] },
      { id: 9, parentId: 1, children: [10, 12] },
      { id: 10, parentId: 9, children: [11] },
      { id: 11, parentId: 10, children: [] },
      { id: 12, parentId: 9, children: [13, 14] },
      { id: 13, parentId: 12, children: [] },
      { id: 14, parentId: 12, children: [15] },
      { id: 15, parentId: 14, children: [16] },
      { id: 16, parentId: 15, children: [] },
      { id: 17, parentId: 1, children: [] },
    ]);
    expect(document.nodes[9].fen).toBe(
      "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    );
    expect(document.nodes[16].fen).toBe(
      "rnb1kbnr/pp2pppp/8/2pq4/8/2P5/PP1P1PPP/RNBQKBNR w KQkq - 0 4",
    );
  });

  it("hydrates a FEN/SetUp start and computes navigation positions from it", () => {
    const document = hydrateGame(readFileSync(resolve("tests/fixtures/fen_start.pgn")));

    expect(document.nodes.map((node) => node.san)).toEqual([
      null,
      "Rf8+",
      "Ka7",
      "Rf7",
      "Ka6",
      "Kb1",
    ]);
    expect(document.nodes[0]).toMatchObject({
      parentId: null,
      ply: 0,
      moveNumber: 1,
      color: "",
      fen: "1k6/1P3R2/8/8/8/8/r7/2K5 w - - 0 1",
      children: [1],
    });
    expect(document.nodes[1]).toMatchObject({
      parentId: 0,
      uci: "f7f8",
      ply: 1,
      moveNumber: 1,
      color: "w",
      fen: "1k3R2/1P6/8/8/8/8/r7/2K5 b - - 1 1",
    });
    expect(document.nodes.at(-1)?.fen).toBe(
      "8/1P3R2/k7/8/8/8/r7/1K6 b - - 5 3",
    );
  });

  it("falls back to the standard start and warns for an invalid FEN header", () => {
    const document = hydrateGame(Buffer.from(
      '[Event "Bad FEN"]\n[SetUp "1"]\n[FEN "totally invalid"]\n\n1. e4 *',
    ));

    expect(document.nodes[0].fen).toBe(
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    );
    expect(document.nodes.slice(1).map((node) => node.san)).toEqual(["e4"]);
    expect(document.warnings).toEqual([
      expect.stringContaining("invalid FEN header, using standard start"),
    ]);
  });

  it("preserves comments, starting comments, NAGs, and warnings in node context", () => {
    const document = hydrateGame(readFileSync(resolve("tests/fixtures/annotations.pgn")));

    expect(document.nodes[document.rootId].comment).toContain("Pre-game introduction comment.");
    const bySan = new Map(
      document.nodes.filter((node) => node.san).map((node) => [node.san, node]),
    );

    expect(bySan.get("e4")).toMatchObject({
      comment: "Best by test.",
      nags: [1],
      glyphs: ["!"],
    });
    expect(bySan.get("e5")).toMatchObject({ nags: [6, 13], glyphs: ["?!", "∞"] });
    expect(bySan.get("Nf3")).toMatchObject({ nags: [1, 14], glyphs: ["!", "⩲"] });
    expect(bySan.get("Nc6")?.comment).toContain("semicolon comment");
    expect(bySan.get("a6")).toMatchObject({ nags: [2], glyphs: ["?"] });
    expect(bySan.get("Ba4")).toMatchObject({ nags: [6], glyphs: ["?!"] });
    expect(document.warnings).toEqual([]);
  });

  it("extracts graphics from root, move, and variation starting comments", () => {
    const document = hydrateGame(readFileSync(resolve("tests/fixtures/graphics.pgn")));
    const bySan = new Map(
      document.nodes.filter((node) => node.san).map((node) => [node.san, node]),
    );

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
    expect(bySan.get("c5")).toMatchObject({
      comment: "",
      highlights: [{ square: "c5", color: "blue" }],
    });
    expect(bySan.get("c3")).toMatchObject({
      startingComment: "pre-move shapes",
      arrows: [{ from: "g1", to: "f3", color: "yellow" }],
    });
    expect(document.warnings).toEqual([]);
    expect(document.source).toContain("[%cal Ge2e4,Rd7d5]");
  });

  it("keeps the legal prefix and reports parser warnings for malformed movetext", () => {
    const source = readFileSync(resolve("tests/fixtures/malformed_middle.pgn"));
    const start = source.indexOf(Buffer.from('[Event "Broken"]'));
    const end = source.indexOf(Buffer.from('[Event "Good Two"]'));
    const document = hydrateGame(source.subarray(start, end));

    expect(document.nodes.slice(1).map((node) => node.san)).toEqual(["e4", "e5"]);
    expect(document.warnings.some((warning) => warning.includes("could not parse PGN tree"))).toBe(true);
  });
});
