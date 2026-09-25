import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { BlobSource } from "../src/browser-source.js";
import { SourceSpanError } from "../src/byte-source.js";
import { hydrateGame } from "../src/hydration.js";
import { scanPgn as scanBytes, type ScannedGame } from "../src/scan.js";
import { scanPgn as scanFile } from "../src/scanner.js";

describe("browser-owned PGN source", () => {
  it("matches filesystem scanning across one-byte chunk boundaries", async () => {
    for (const filename of ["basic_two_games.pgn", "malformed_middle.pgn", "variations.pgn"]) {
      const path = resolve("tests/fixtures", filename);
      const bytes = readFileSync(path);
      const browserGames = await collect(scanBytes(new BlobSource(chunkedBlob(bytes, 1))));
      const desktopGames = await collect(scanFile(path));

      expect(browserGames, filename).toEqual(desktopGames);
    }
  });

  it("keeps offsets through split BOM, UTF-8, long lines, and variations", async () => {
    const sourceText = [
      '\ufeff[Event "Browser source"]',
      '[White "José"]',
      '[Black "München"]',
      "",
      `1. e4 (1. d4 {variation}) ${"e5 ".repeat(20_000)}*`,
      "",
    ].join("\r\n");
    const sourceBytes = new TextEncoder().encode(sourceText);
    const source = new BlobSource(chunkedBlob(sourceBytes, 3));
    const games = await collect(scanBytes(source));

    expect(games).toEqual([{
      idxInFile: 0,
      offsetStart: 0,
      offsetEnd: sourceBytes.byteLength - 2,
      headers: [
        ["Event", "Browser source"],
        ["White", "José"],
        ["Black", "München"],
      ],
      warning: null,
    }]);
    const span = await source.readSpan(games[0].offsetStart, games[0].offsetEnd, 8 * 1024 * 1024);
    expect(span).toEqual(sourceBytes.subarray(games[0].offsetStart, games[0].offsetEnd));
    expect(hydrateGame(span, games[0].headers).headers).toEqual(games[0].headers);
  });

  it("reports progress and preserves malformed-record warnings", async () => {
    const corpus = JSON.parse(
      readFileSync(resolve("tests/fixtures/scan_corpus.json"), "utf8"),
    ) as { cases: Array<{ name: string; source: string; games: ScannedGame[] }> };
    const difficult = corpus.cases.find(({ name }) => name === "difficult-source");
    if (!difficult) throw new Error("difficult scan corpus case is missing");
    const sourceBytes = new TextEncoder().encode(difficult.source);
    const progress: Array<[number, number, number]> = [];

    const games = await collect(scanBytes(
      new BlobSource(chunkedBlob(sourceBytes, 1)),
      (done, total, found) => progress.push([done, total, found]),
      7,
    ));

    expect(games).toEqual(difficult.games);
    expect(progress.at(-1)).toEqual([sourceBytes.byteLength, sourceBytes.byteLength, 5]);
    expect(progress.every(([done, total], index) =>
      total === sourceBytes.byteLength && (index === 0 || done >= progress[index - 1][0]),
    )).toBe(true);
  });

  it("enforces the bounded span contract", async () => {
    const source = new BlobSource(new Blob(["0123456789"]));

    await expect(source.readSpan(0, 5, 4)).rejects.toThrowError(SourceSpanError);
    await expect(source.readSpan(5, 4, 10)).rejects.toThrowError(SourceSpanError);
    await expect(source.readSpan(0, 11, 20)).rejects.toThrowError(SourceSpanError);
  });
});

async function collect(scan: AsyncIterable<ScannedGame>): Promise<ScannedGame[]> {
  const games: ScannedGame[] = [];
  for await (const game of scan) games.push(game);
  return games;
}

function chunkedBlob(bytes: Uint8Array, chunkSize: number): Blob {
  const blob = new Blob([copyArrayBuffer(bytes)]);
  return {
    size: blob.size,
    slice: blob.slice.bind(blob),
    stream: () => new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
          controller.enqueue(bytes.subarray(offset, offset + chunkSize));
        }
        controller.close();
      },
    }),
  } as unknown as Blob;
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
