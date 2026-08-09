import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { fingerprintFile, readGameBytes, scanPgn, type ScannedGame } from "../src/scanner.js";

const scanContract = JSON.parse(
  readFileSync(join(resolve("tests/fixtures"), "scan_contract.json"), "utf8"),
) as {
  source: string;
  games: Array<{
    idxInFile: number;
    offsetStart: number;
    offsetEnd: number;
    headers: ScannedGame["headers"];
    warning: string | null;
  }>;
};

const fixtureDirectory = resolve("tests/fixtures");
const temporaryDirectories: string[] = [];

type ScanCorpusCase = {
  name: string;
  source?: string;
  repeat?: number;
  template?: string;
  recordBytes: number;
  games: Array<{
    idxInFile: number;
    offsetStart: number;
    offsetEnd: number;
    headers: ScannedGame["headers"];
    warning: string | null;
  }>;
  sourceContains: string[];
};

const scanCorpus = JSON.parse(
  readFileSync(join(fixtureDirectory, "scan_corpus.json"), "utf8"),
) as { cases: ScanCorpusCase[] };

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => {
    rmSync(directory, { force: true, recursive: true });
  });
});

async function scan(path: string) {
  const games: ScannedGame[] = [];
  for await (const game of scanPgn(path)) games.push(game);
  return games;
}

function corpusSource(corpusCase: ScanCorpusCase): string {
  if (corpusCase.source !== undefined) return corpusCase.source;
  if (corpusCase.template === undefined || corpusCase.repeat === undefined) {
    throw new Error(`invalid scan corpus case: ${corpusCase.name}`);
  }
  return Array.from({ length: corpusCase.repeat }, (_, index) =>
    corpusCase.template!.replaceAll("{{index}}", String(index).padStart(4, "0")),
  ).join("");
}

describe("PGN source scanner", () => {
  it("matches the shared scan contract", async () => {
    const games = await scan(join(fixtureDirectory, scanContract.source));

    expect(games).toEqual(scanContract.games);
  });

  it("matches the shared difficult-source corpus byte-for-byte", async () => {
    for (const corpusCase of scanCorpus.cases) {
      const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-corpus-"));
      temporaryDirectories.push(directory);
      const sourceText = corpusSource(corpusCase);
      const sourceBytes = Buffer.from(sourceText, "utf8");
      const path = join(directory, `${corpusCase.name}.pgn`);
      writeFileSync(path, sourceBytes);

      const games = await scan(path);
      if (corpusCase.games.length > 0) {
        expect(games).toEqual(corpusCase.games);
        for (const expected of corpusCase.games) {
          const actualBytes = readGameBytes(
            path,
            expected.offsetStart,
            expected.offsetEnd,
            8 * 1024 * 1024,
          );
          expect(actualBytes).toEqual(sourceBytes.subarray(expected.offsetStart, expected.offsetEnd));
          expect(actualBytes.toString("utf8")).toBe(
            sourceBytes.subarray(expected.offsetStart, expected.offsetEnd).toString("utf8"),
          );
        }
      } else {
        expect(corpusCase.repeat).toBeDefined();
        expect(games).toHaveLength(corpusCase.repeat!);
        for (const [index, game] of games.entries()) {
          const value = String(index).padStart(4, "0");
          expect(game).toEqual({
            idxInFile: index,
            offsetStart: index * corpusCase.recordBytes,
            offsetEnd: (index + 1) * corpusCase.recordBytes - 2,
            headers: [
              ["Event", `Bulk ${value}`],
              ["Site", "Generated"],
              ["Round", value],
              ["White", `Player ${value}`],
              ["Black", `Opponent ${value}`],
              ["Result", "1-0"],
            ],
            warning: null,
          });
        }
      }
      for (const expectedText of corpusCase.sourceContains) {
        expect(sourceText).toContain(expectedText);
      }
    }
  });

  it("finds normal game boundaries and preserves ordered tag pairs", async () => {
    const path = join(fixtureDirectory, "basic_two_games.pgn");
    const games = await scan(path);

    expect(games).toHaveLength(2);
    expect(games[0]).toMatchObject({
      idxInFile: 0,
      headers: expect.arrayContaining([
        ["White", "Alpha, A."],
        ["ECO", "C50"],
      ]),
      warning: null,
    });
    expect(games[1]).toMatchObject({
      idxInFile: 1,
      headers: expect.arrayContaining([["Round", "2"]]),
    });

    const source = readFileSync(path);
    expect(source.subarray(games[0].offsetStart, games[0].offsetEnd).toString()).toContain("1-0");
    expect(source.subarray(games[0].offsetStart, games[0].offsetEnd).toString()).not.toContain(
      "1/2-1/2",
    );
    expect(games[0].offsetEnd).toBeLessThanOrEqual(games[1].offsetStart);
  });

  it("keeps fake tags inside brace comments and handles headers-only games", async () => {
    const commentGames = await scan(join(fixtureDirectory, "comment_trap.pgn"));
    expect(commentGames).toHaveLength(2);
    expect(commentGames[0].headers[0]).toEqual(["Event", "Trap A"]);
    expect(
      readGameBytes(
        join(fixtureDirectory, "comment_trap.pgn"),
        commentGames[0].offsetStart,
        commentGames[0].offsetEnd,
        8 * 1024 * 1024,
      ).toString(),
    ).toContain("NOT A REAL GAME");

    const headerGames = await scan(join(fixtureDirectory, "headers_only.pgn"));
    expect(headerGames).toHaveLength(2);
    expect(headerGames.map((game) => game.headers.find(([name]) => name === "White")?.[1])).toEqual([
      "NoMoves",
      "Has",
    ]);
  });

  it("preserves raw offsets across a BOM and CRLF source", async () => {
    const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-scanner-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "crlf.pgn");
    const text =
      '[Event "BOM Game"]\r\n[White "Bom"]\r\n[Black "Crlf"]\r\n\r\n' +
      "1. e4 {déjà vu} *\r\n\r\n" +
      '[Event "Second"]\r\n[White "Two"]\r\n[Black "Games"]\r\n\r\n1. d4 *\r\n';
    writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]));

    const games = await scan(path);
    expect(games).toHaveLength(2);
    expect(games[0].offsetStart).toBe(0);
    expect(games[0].headers[0]).toEqual(["Event", "BOM Game"]);
    const firstGameBytes = readGameBytes(
      path,
      games[0].offsetStart,
      games[0].offsetEnd,
      8 * 1024 * 1024,
    );
    expect(firstGameBytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(firstGameBytes.subarray(3).toString()).toMatch(/^\[Event "BOM Game"\]/);
    expect(firstGameBytes.toString()).toContain("déjà vu");
  });

  it("ignores escape lines and flags a tagless game", async () => {
    const escaped = await scan(join(fixtureDirectory, "escape_lines.pgn"));
    expect(escaped).toHaveLength(1);
    expect(escaped[0].headers[0]).toEqual(["Event", "Escaped"]);

    const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-scanner-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "tagless.pgn");
    writeFileSync(path, '1. e4 e5 *\n\n[Event "Tagged"]\n\n1. d4 *\n');
    const games = await scan(path);
    expect(games).toHaveLength(2);
    expect(games[0].warning).toBe("movetext with no tag section");
    expect(games[1].headers[0]).toEqual(["Event", "Tagged"]);
  });

  it("keeps malformed neighbors and semicolon comments isolated", async () => {
    const malformed = await scan(join(fixtureDirectory, "malformed_middle.pgn"));
    expect(malformed).toHaveLength(3);
    expect(malformed.map((game) => game.headers.find(([name]) => name === "Event")?.[1])).toEqual([
      "Good One",
      "Broken",
      "Good Two",
    ]);

    const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-scanner-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "comments.pgn");
    writeFileSync(
      path,
      '[Event "Semi"]\n\n1. e4 ; comment with { an unmatched brace\n2. Nf3 *\n\n' +
        '[Event "Next"]\n\n1. d4 *\n',
    );
    const games = await scan(path);
    expect(games).toHaveLength(2);
    expect(games[1].headers[0]).toEqual(["Event", "Next"]);
  });

  it("preserves duplicate tags while projecting the last value for indexing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-scanner-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "duplicates.pgn");
    writeFileSync(
      path,
      '[Event "First"]\n[Event "Last"]\n[White "Player"]\n[White "Final"]\n\n1. e4 *\n',
    );

    const games = await scan(path);
    expect(games).toHaveLength(1);
    expect(games[0].headers).toEqual([
      ["Event", "First"],
      ["Event", "Last"],
      ["White", "Player"],
      ["White", "Final"],
    ]);
  });

  it("handles a very long single-line movetext without changing the boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-scanner-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "long-line.pgn");
    writeFileSync(
      path,
      '[Event "Long"]\n[White "Player"]\n[Black "Opponent"]\n\n' +
        `1. ${"e4 ".repeat(250_000)}*\n`,
    );

    const games = await scan(path);
    expect(games).toHaveLength(1);
    expect(games[0].headers[0]).toEqual(["Event", "Long"]);
    expect(games[0].offsetEnd).toBe(readFileSync(path).byteLength - 1);
  });

  it("keeps a large valid tag value in the ordered headers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-scanner-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "long-tag.pgn");
    const event = "x".repeat(70_000);
    writeFileSync(path, `[Event "${event}"]\n\n1. e4 *\n`);

    const games = await scan(path);
    expect(games).toHaveLength(1);
    expect(games[0].headers[0]).toEqual(["Event", event]);
  });

  it("reports final progress and fingerprints source changes", async () => {
    const path = join(fixtureDirectory, "basic_two_games.pgn");
    const progress: Array<[number, number, number]> = [];
    const games: ScannedGame[] = [];
    for await (const game of scanPgn(path, (done, total, found) => {
      progress.push([done, total, found]);
    })) {
      games.push(game);
    }

    expect(games).toHaveLength(2);
    expect(progress.at(-1)).toEqual([readFileSync(path).byteLength, readFileSync(path).byteLength, 2]);
    const before = fingerprintFile(path);
    const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-scanner-"));
    temporaryDirectories.push(directory);
    const copy = join(directory, "copy.pgn");
    writeFileSync(copy, readFileSync(path));
    const copyBefore = fingerprintFile(copy);
    writeFileSync(copy, Buffer.concat([readFileSync(copy), Buffer.from("\n")]));
    expect(before).toBe(fingerprintFile(path));
    expect(fingerprintFile(copy)).not.toBe(copyBefore);
  });
});
