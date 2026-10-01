import { describe, expect, it } from "vitest";

import {
  InMemoryMobileLibrary,
  MOBILE_MAX_GAME_BYTES,
  MOBILE_MAX_SOURCE_BYTES,
  MOBILE_PAGE_SIZE,
  PersistentMobileLibrary,
  type MobileScanWorker,
} from "../src/mobile/library.js";
import type { MobileScanMessage, MobileScanRequest } from "../src/mobile/scan-protocol.js";
import type {
  MobileLegacyLibrarySnapshot,
  MobileLibrarySnapshot,
  MobileLibraryStorage,
  MobileMultiSourceLibrarySnapshot,
  MobileStoredSnapshot,
} from "../src/mobile/storage.js";

class ManualWorker implements MobileScanWorker {
  onmessage: MobileScanWorker["onmessage"] = null;
  onerror: MobileScanWorker["onerror"] = null;
  terminated = false;
  request: MobileScanRequest | null = null;

  postMessage(message: MobileScanRequest): void {
    this.request = message;
  }

  terminate(): void {
    this.terminated = true;
  }

  send(message: MobileScanMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<MobileScanMessage>);
  }
}

describe("in-memory Mobile Library", () => {
  it("projects scanner progress and Game record metadata", () => {
    const worker = new ManualWorker();
    const library = new InMemoryMobileLibrary(() => worker);

    library.replaceSource({ name: "study.pgn", blob: new Blob(["bytes"]) });
    expect(library.source).toBeNull();
    expect(library.replacement).toMatchObject({
      name: "study.pgn",
      size: 5,
      scan_status: "scanning",
      progress: { bytesDone: 0, bytesTotal: 5, gamesFound: 0 },
    });
    worker.send({ type: "progress", bytesDone: 5, bytesTotal: 5, gamesFound: 1 });
    worker.send({
      type: "game",
      game: {
        idxInFile: 0,
        offsetStart: 0,
        offsetEnd: 5,
        headers: [
          ["Event", "Study"],
          ["White", "First white"],
          ["White", "Final white"],
          ["Black", "Black"],
          ["Result", "1-0"],
          ["ECO", "C20"],
          ["Opening", "King Pawn"],
          ["FEN", "8/8/8/8/8/8/8/8 w - - 0 1"],
        ],
        warning: "incomplete movetext",
      },
    });
    worker.send({ type: "complete" });

    expect(library.source).toMatchObject({
      scan_status: "ready",
      game_count: 1,
      warning_count: 1,
      progress: { bytesDone: 5, bytesTotal: 5, gamesFound: 1 },
    });
    expect(library.listGames().games).toEqual([{
      id: 1,
      idx_in_file: 0,
      event: "Study",
      site: "",
      date: "",
      round: "",
      white: "Final white",
      black: "Black",
      result: "1-0",
      eco: "C20",
      opening: "King Pawn",
      has_fen: 1,
      warning: "incomplete movetext",
      byte_size: 5,
    }]);
  });

  it("retains multiple sources and gives their Game records distinct ids", async () => {
    const workers: ManualWorker[] = [];
    const library = new InMemoryMobileLibrary(() => {
      const worker = new ManualWorker();
      workers.push(worker);
      return worker;
    });

    library.replaceSource({ name: "first.pgn", blob: new Blob(["first"]) });
    workers[0].send(gameMessage("First"));
    workers[0].send({ type: "complete" });
    library.replaceSource({ name: "second.pgn", blob: new Blob(["second"]) });

    expect(workers[0].terminated).toBe(true);
    workers[0].send(gameMessage("stale"));
    workers[1].send(gameMessage("Second"));
    workers[1].send({ type: "complete" });

    expect(library.sources.map((source) => source.name)).toEqual(["first.pgn", "second.pgn"]);
    expect(library.source).toMatchObject({
      name: "second.pgn",
      scan_status: "ready",
      game_count: 1,
    });
    expect(library.listGames().games.map((game) => game.event)).toEqual(["Second"]);
    expect(library.listGames().games[0].id).toBe(2);
    await library.selectSource(1);
    expect(library.listGames().games.map((game) => game.event)).toEqual(["First"]);
    expect(library.activeSourceId).toBe(1);
    await library.removeSource(2);
    expect(library.source?.name).toBe("first.pgn");
    await library.removeSource(1);
    expect(library.source).toBeNull();
    expect(library.sources).toEqual([]);
  });

  it("caps pages and searches across the roster and metadata fields", () => {
    const worker = new ManualWorker();
    const library = new InMemoryMobileLibrary(() => worker);
    library.replaceSource({ name: "many.pgn", blob: new Blob(["source"]) });

    for (let index = 0; index < MOBILE_PAGE_SIZE + 1; index += 1) {
      worker.send(gameMessage(`Event ${index}`, index === MOBILE_PAGE_SIZE ? "Opening target" : ""));
    }
    worker.send({ type: "complete" });

    expect(library.listGames("opening target", 0, 500).games).toHaveLength(1);
    expect(library.listGames("opening target").games[0].event).toBe(`Event ${MOBILE_PAGE_SIZE}`);
    expect(library.listGames("", 0, 500).games).toHaveLength(MOBILE_PAGE_SIZE);
    expect(library.listGames("Player 0").games[0].white).toBe("Player 0");
  });

  it("hydrates one selected Game record from its retained Blob span", async () => {
    const sourceText = [
      '[Event "First"]',
      '[White "One"]',
      "",
      "1. e4 *",
      "",
      '[Event "Second"]',
      '[Event "Second duplicate"]',
      '[White "Two"]',
      '[SetUp "1"]',
      '[FEN "1k6/1P3R2/8/8/8/8/r7/2K5 w - - 0 1"]',
      "",
      "1. Rf8+ Ka7 1-0",
    ].join("\n");
    const secondStart = sourceText.indexOf('[Event "Second"]');
    const worker = new ManualWorker();
    const library = new InMemoryMobileLibrary(() => worker);
    library.replaceSource({ name: "selected.pgn", blob: new Blob([sourceText]) });
    worker.send({
      type: "game",
      game: {
        idxInFile: 0,
        offsetStart: 0,
        offsetEnd: secondStart,
        headers: [["Event", "First"], ["White", "One"]],
        warning: null,
      },
    });
    worker.send({
      type: "game",
      game: {
        idxInFile: 1,
        offsetStart: secondStart,
        offsetEnd: sourceText.length,
        headers: [
          ["Event", "Second"],
          ["Event", "Second duplicate"],
          ["White", "Two"],
          ["SetUp", "1"],
          ["FEN", "1k6/1P3R2/8/8/8/8/r7/2K5 w - - 0 1"],
        ],
        warning: null,
      },
    });
    worker.send({ type: "complete" });

    const document = await library.getGameDocument(2);

    expect(document.headers).toEqual([
      ["Event", "Second"],
      ["Event", "Second duplicate"],
      ["White", "Two"],
      ["SetUp", "1"],
      ["FEN", "1k6/1P3R2/8/8/8/8/r7/2K5 w - - 0 1"],
    ]);
    expect(document.nodes[0].fen).toBe("1k6/1P3R2/8/8/8/8/r7/2K5 w - - 0 1");
    expect(document.nodes[1].san).toBe("Rf8+");
    expect(document.neighbors).toEqual({ prev: 1, next: null });
    expect(document.source).toBe(sourceText.slice(secondStart));
  });

  it("starts without Resume bookmarks and remembers the latest Game record per source", async () => {
    const workers: ManualWorker[] = [];
    const library = new InMemoryMobileLibrary(() => {
      const worker = new ManualWorker();
      workers.push(worker);
      return worker;
    });

    const first = library.replaceSource({ name: "first.pgn", blob: new Blob(["first"]) });
    workers[0].send(gameMessage("First 0"));
    workers[0].send(gameMessage("First 1"));
    workers[0].send({ type: "complete" });
    await first;
    const firstGames = library.listGames().games;
    expect(library.source?.resumeBookmark).toBeNull();

    const second = library.replaceSource({ name: "second.pgn", blob: new Blob(["second"]) });
    workers[1].send(gameMessage("Second"));
    workers[1].send({ type: "complete" });
    await second;
    const secondGame = library.listGames().games[0];
    expect(library.source?.resumeBookmark).toBeNull();

    await library.rememberGame(2, secondGame.id);
    await library.rememberGame(2, secondGame.id + 1);
    expect(library.source?.resumeBookmark).toEqual({ sourceId: 2, gameId: secondGame.id });

    await library.selectSource(1);
    await library.rememberGame(1, firstGames[0].id);
    expect(library.source?.resumeBookmark).toEqual({ sourceId: 1, gameId: firstGames[0].id });
    await library.rememberGame(1, firstGames[1].id);
    expect(library.source?.resumeBookmark).toEqual({ sourceId: 1, gameId: firstGames[1].id });

    await library.selectSource(2);
    expect(library.source?.resumeBookmark).toEqual({ sourceId: 2, gameId: secondGame.id });
  });
});

class MemoryMobileStorage implements MobileLibraryStorage {
  snapshot: MobileStoredSnapshot | null = null;
  loadError: Error | null = null;
  saveError: Error | null = null;
  clearError: Error | null = null;

  async load(): Promise<MobileStoredSnapshot | null> {
    if (this.loadError) throw this.loadError;
    return this.snapshot;
  }

  async save(snapshot: MobileLibrarySnapshot): Promise<void> {
    if (this.saveError) throw this.saveError;
    this.snapshot = snapshot;
  }

  async clear(): Promise<void> {
    if (this.clearError) throw this.clearError;
    this.snapshot = null;
  }
}

describe("persistent Mobile Library", () => {
  it("persists source bytes and Index data, then restores a readable GameDocument", async () => {
    const storage = new MemoryMobileStorage();
    const workers: ManualWorker[] = [];
    const library = new PersistentMobileLibrary(() => {
      const worker = new ManualWorker();
      workers.push(worker);
      return worker;
    }, storage);
    await library.ready();

    const sourceText = '[Event "Persisted"]\n[Event "Duplicate"]\n[White "Reader"]\n\n1. e4 *\n';
    const replacement = library.replaceSource({
      name: "persisted.pgn",
      blob: new Blob([sourceText]),
    });
    workers[0].send({ type: "game", game: scannedGame(0, sourceText, [
      ["Event", "Persisted"],
      ["Event", "Duplicate"],
      ["White", "Reader"],
    ], "malformed record") });
    workers[0].send({ type: "complete" });
    await replacement;

    expect(storage.snapshot).toMatchObject({
      schemaVersion: 3,
      activeSourceId: 1,
      sources: [{
        source: {
          id: 1,
          name: "persisted.pgn",
          size: new TextEncoder().encode(sourceText).byteLength,
          game_count: 1,
          warning_count: 1,
          scan_status: "ready",
        },
        games: [{
          scanned: {
            offsetStart: 0,
            offsetEnd: new TextEncoder().encode(sourceText).byteLength,
            headers: [
              ["Event", "Persisted"],
              ["Event", "Duplicate"],
              ["White", "Reader"],
            ],
            warning: "malformed record",
          },
          record: { id: 1 },
        }],
      }],
    });

    const restored = new PersistentMobileLibrary(() => {
      throw new Error("restore should not start a Scan worker");
    }, storage);
    await restored.ready();
    expect(restored.source).toMatchObject({
      name: "persisted.pgn",
      scan_status: "ready",
      game_count: 1,
      warning_count: 1,
    });
    expect(restored.listGames().games[0].warning).toBe("malformed record");
    const document = await restored.getGameDocument(1);
    expect(document.headers).toEqual([
      ["Event", "Persisted"],
      ["Event", "Duplicate"],
      ["White", "Reader"],
    ]);
    expect(document.warnings).toEqual(["index warning: malformed record"]);
    expect(document.source).toBe(sourceText);
  });

  it("persists a source collection, active selection, and source-specific Game identity", async () => {
    const storage = new MemoryMobileStorage();
    const workers: ManualWorker[] = [];
    const library = new PersistentMobileLibrary(() => {
      const worker = new ManualWorker();
      workers.push(worker);
      return worker;
    }, storage);
    await library.ready();

    await completeReplacement(library, workers, "zeta.pgn", '[Event "Zeta"]\n\n1. e4 *\n');
    await completeReplacement(library, workers, "Alpha.pgn", '[Event "Alpha"]\n\n1. d4 *\n');

    expect(library.sources.map((source) => source.name)).toEqual(["Alpha.pgn", "zeta.pgn"]);
    const alphaId = library.sources.find((source) => source.name === "Alpha.pgn")!.id;
    const zetaId = library.sources.find((source) => source.name === "zeta.pgn")!.id;
    const alphaGameId = library.listGames().games[0].id;
    expect(library.source?.id).toBe(alphaId);
    expect(alphaGameId).not.toBe(1);

    await library.selectSource(zetaId);
    const zetaGame = library.listGames().games[0];
    expect(library.source?.name).toBe("zeta.pgn");
    expect(zetaGame.event).toBe("Zeta");
    expect(zetaGame.id).not.toBe(alphaGameId);
    expect((await library.getGameDocument(zetaGame.id)).source).toContain('[Event "Zeta"]');

    await library.selectSource(alphaId);
    await library.removeSource(zetaId);
    expect(library.source?.name).toBe("Alpha.pgn");
    expect(library.listGames().games[0].event).toBe("Alpha");

    const restored = new PersistentMobileLibrary(() => {
      const worker = new ManualWorker();
      workers.push(worker);
      return worker;
    }, storage);
    await restored.ready();
    expect(restored.activeSourceId).toBe(alphaId);
    expect(restored.sources.map((source) => source.name)).toEqual(["Alpha.pgn"]);
    expect(restored.listGames().games[0].event).toBe("Alpha");

    await completeReplacement(restored, workers, "second.pgn", '[Event "Second"]\n\n1. c4 *\n');
    const secondId = restored.activeSourceId!;
    await restored.removeSource(secondId);
    expect(restored.activeSourceId).toBeNull();
    expect(restored.source).toBeNull();
    expect(restored.sources.map((source) => source.name)).toEqual(["Alpha.pgn"]);

    const noSelectionAfterRelaunch = new PersistentMobileLibrary(() => {
      throw new Error("restore should not start a Scan worker");
    }, storage);
    await noSelectionAfterRelaunch.ready();
    expect(noSelectionAfterRelaunch.activeSourceId).toBeNull();
    expect(noSelectionAfterRelaunch.sources.map((source) => source.name)).toEqual(["Alpha.pgn"]);
  });

  it("migrates the v1 one-source snapshot without losing bytes or Game records", async () => {
    const sourceText = '[Event "Legacy"]\n[White "Reader"]\n\n1. e4 *\n';
    const sourceBytes = new TextEncoder().encode(sourceText).buffer;
    const storage = new MemoryMobileStorage();
    const scanned = scannedGame(0, sourceText, [["Event", "Legacy"], ["White", "Reader"]]);
    const legacy: MobileLegacyLibrarySnapshot = {
      schemaVersion: 1,
      source: {
        name: "legacy.pgn",
        size: sourceBytes.byteLength,
        game_count: 1,
        warning_count: 0,
        scan_status: "ready",
        scan_error: null,
        progress: {
          bytesDone: sourceBytes.byteLength,
          bytesTotal: sourceBytes.byteLength,
          gamesFound: 1,
        },
      },
      sourceBytes,
      games: [{
        scanned,
        record: {
          id: 1,
          idx_in_file: 0,
          event: "Legacy",
          site: "",
          date: "",
          round: "",
          white: "Reader",
          black: "",
          result: "",
          eco: "",
          opening: "",
          has_fen: 0,
          warning: null,
          byte_size: sourceBytes.byteLength,
        },
      }],
    };
    storage.snapshot = legacy;

    const library = new PersistentMobileLibrary(() => {
      throw new Error("migration should not start a Scan worker");
    }, storage);
    await library.ready();

    expect(library.source).toMatchObject({ id: 1, name: "legacy.pgn", game_count: 1 });
    expect(library.listGames().games[0].event).toBe("Legacy");
    expect((await library.getGameDocument(1)).source).toBe(sourceText);
    expect(storage.snapshot).toMatchObject({ schemaVersion: 3, activeSourceId: 1 });
    const migrated = await storage.load();
    if (!migrated || migrated.schemaVersion !== 3) throw new Error("migration did not save v3 data");
    expect(migrated.sources[0].sourceBytes).toEqual(sourceBytes);
    expect(migrated.sources[0].source.resumeBookmark).toBeNull();
  });

  it("migrates the v2 source collection without inventing Resume bookmarks", async () => {
    const storage = new MemoryMobileStorage();
    const workers: ManualWorker[] = [];
    const library = new PersistentMobileLibrary(() => {
      const worker = new ManualWorker();
      workers.push(worker);
      return worker;
    }, storage);
    await library.ready();

    await completeReplacement(library, workers, "first.pgn", '[Event "First"]\n\n1. e4 *\n');
    await completeReplacement(library, workers, "second.pgn", '[Event "Second"]\n\n1. d4 *\n');
    const firstId = library.sources.find((source) => source.name === "first.pgn")!.id;
    await library.selectSource(firstId);
    await library.rememberGame(firstId, library.listGames().games[0].id);
    await library.selectSource(2);

    const current = storage.snapshot;
    if (!current || current.schemaVersion !== 3) throw new Error("expected a v3 snapshot");
    storage.snapshot = {
      schemaVersion: 2,
      activeSourceId: current.activeSourceId,
      sources: current.sources.map(({ source, sourceBytes, games }) => {
        const { resumeBookmark: _resumeBookmark, ...sourceWithoutBookmark } = source;
        return { source: sourceWithoutBookmark, sourceBytes, games };
      }),
    } satisfies MobileMultiSourceLibrarySnapshot;

    const restored = new PersistentMobileLibrary(() => {
      throw new Error("migration should not start a Scan worker");
    }, storage);
    await restored.ready();

    expect(restored.sources.map((source) => source.name)).toEqual(["first.pgn", "second.pgn"]);
    expect(restored.sources.every((source) => source.resumeBookmark === null)).toBe(true);
    expect(restored.activeSourceId).toBe(2);
    expect(storage.snapshot).toMatchObject({ schemaVersion: 3 });
  });

  it("persists per-source Resume bookmarks, restores them, and removes them with the source", async () => {
    const storage = new MemoryMobileStorage();
    const workers: ManualWorker[] = [];
    const library = new PersistentMobileLibrary(() => {
      const worker = new ManualWorker();
      workers.push(worker);
      return worker;
    }, storage);
    await library.ready();

    await completeReplacement(library, workers, "first.pgn", '[Event "First"]\n\n1. e4 *\n');
    const firstId = library.activeSourceId!;
    const firstGameId = library.listGames().games[0].id;
    await completeReplacement(library, workers, "second.pgn", '[Event "Second"]\n\n1. d4 *\n');
    const secondId = library.activeSourceId!;
    const secondGameId = library.listGames().games[0].id;

    await library.rememberGame(firstId, firstGameId);
    await library.rememberGame(secondId, secondGameId);
    await library.selectSource(firstId);

    const restored = new PersistentMobileLibrary(() => {
      throw new Error("restore should not start a Scan worker");
    }, storage);
    await restored.ready();
    expect(restored.activeSourceId).toBe(firstId);
    expect(restored.sources.find((source) => source.id === firstId)?.resumeBookmark)
      .toEqual({ sourceId: firstId, gameId: firstGameId });
    expect(restored.sources.find((source) => source.id === secondId)?.resumeBookmark)
      .toEqual({ sourceId: secondId, gameId: secondGameId });

    await restored.removeSource(firstId);
    expect(restored.sources.find((source) => source.id === firstId)).toBeUndefined();
    const afterRemoval = new PersistentMobileLibrary(() => {
      throw new Error("restore should not start a Scan worker");
    }, storage);
    await afterRemoval.ready();
    expect(afterRemoval.sources.map((source) => source.id)).toEqual([secondId]);
    expect(afterRemoval.sources[0].resumeBookmark).toEqual({ sourceId: secondId, gameId: secondGameId });
  });

  it("keeps the active source while a replacement is cancelled, invalid, unreadable, or over-limit", async () => {
    const storage = new MemoryMobileStorage();
    const workers: ManualWorker[] = [];
    const library = new PersistentMobileLibrary(() => {
      const worker = new ManualWorker();
      workers.push(worker);
      return worker;
    }, storage);
    await library.ready();
    const firstText = '[Event "First"]\n\n1. e4 *\n';
    await completeReplacement(library, workers, "first.pgn", firstText);

    const invalid = library.replaceSource({ name: "notes.txt", blob: new Blob(["invalid"]) });
    await invalid;
    expect(library.source?.name).toBe("first.pgn");
    expect(library.error).toContain("ends in .pgn");

    const cancelled = library.replaceSource({
      name: "cancelled.pgn",
      blob: new Blob(["cancelled"]),
    });
    library.cancelReplacement();
    await cancelled;
    expect(library.source?.name).toBe("first.pgn");
    expect(library.listGames().games[0].event).toBe("First");

    const unreadable = library.replaceSource({
      name: "unreadable.pgn",
      blob: new Blob(["unreadable"]),
    });
    workers.at(-1)!.send({ type: "error", error: "source could not be read" });
    await unreadable;
    expect(library.source?.name).toBe("first.pgn");
    expect(library.error).toContain("source could not be read");

    const oversized = library.replaceSource({
      name: "oversized.pgn",
      blob: sizedBlob(MOBILE_MAX_SOURCE_BYTES + 1),
    });
    await oversized;
    expect(library.source?.name).toBe("first.pgn");
    expect(library.error).toContain("50 MiB");

    const gameTooLarge = library.replaceSource({
      name: "large-game.pgn",
      blob: sizedBlob(MOBILE_MAX_GAME_BYTES + 1),
    });
    workers.at(-1)!.send({
      type: "game",
      game: scannedGame(0, "", [["Event", "Too large"]], null, MOBILE_MAX_GAME_BYTES + 1),
    });
    await gameTooLarge;
    expect(library.source?.name).toBe("first.pgn");
    expect(library.error).toContain("8 MiB");
  });

  it("leaves the prior snapshot and active reader data on storage failure", async () => {
    const storage = new MemoryMobileStorage();
    const workers: ManualWorker[] = [];
    const library = new PersistentMobileLibrary(() => {
      const worker = new ManualWorker();
      workers.push(worker);
      return worker;
    }, storage);
    await library.ready();
    const firstText = '[Event "First"]\n\n1. e4 *\n';
    await completeReplacement(library, workers, "first.pgn", firstText);
    const priorSnapshot = storage.snapshot;
    storage.saveError = new Error("quota exceeded");

    const replacement = library.replaceSource({
      name: "replacement.pgn",
      blob: new Blob(['[Event "Replacement"]\n\n1. d4 *\n']),
    });
    workers.at(-1)!.send({
      type: "game",
      game: scannedGame(0, '[Event "Replacement"]\n\n1. d4 *\n', [["Event", "Replacement"]]),
    });
    workers.at(-1)!.send({ type: "complete" });
    await replacement;

    expect(library.source?.name).toBe("first.pgn");
    expect(library.listGames().games[0].event).toBe("First");
    expect(await library.getGameDocument(1).then((document) => document.source)).toBe(firstText);
    expect(storage.snapshot).toBe(priorSnapshot);
    expect(library.error).toContain("quota exceeded");

    storage.saveError = new Error("clear quota exceeded");
    await library.clear();
    expect(library.source?.name).toBe("first.pgn");
    expect(library.listGames().games[0].event).toBe("First");
    expect(library.error).toContain("clear quota exceeded");
  });

  it("accepts a source at the exact 50 MiB boundary", async () => {
    const storage = new MemoryMobileStorage();
    const workers: ManualWorker[] = [];
    const library = new PersistentMobileLibrary(() => {
      const worker = new ManualWorker();
      workers.push(worker);
      return worker;
    }, storage);
    await library.ready();

    const source = new Blob([new Uint8Array(MOBILE_MAX_SOURCE_BYTES)]);
    const replacement = library.replaceSource({ name: "boundary.pgn", blob: source });
    workers[0].send({
      type: "game",
      game: scannedGame(0, "", [["Event", "Boundary"]], null, 1),
    });
    workers[0].send({ type: "complete" });
    await replacement;

    expect(library.error).toBeNull();
    expect(library.source).toMatchObject({
      name: "boundary.pgn",
      size: MOBILE_MAX_SOURCE_BYTES,
      game_count: 1,
      scan_status: "ready",
    });
    expect((storage.snapshot as MobileLibrarySnapshot).sources[0].sourceBytes.byteLength)
      .toBe(MOBILE_MAX_SOURCE_BYTES);
  });

  it("accepts more than sixty Game records and can clear the persisted source", async () => {
    const storage = new MemoryMobileStorage();
    const workers: ManualWorker[] = [];
    const library = new PersistentMobileLibrary(() => {
      const worker = new ManualWorker();
      workers.push(worker);
      return worker;
    }, storage);
    await library.ready();
    const source = new Blob(["x"]);
    const replacement = library.replaceSource({ name: "many.pgn", blob: source });
    for (let index = 0; index < 61; index += 1) {
      workers[0].send({
        type: "game",
        game: scannedGame(index, "x", [["Event", `Event ${index}`]], null, 1),
      });
    }
    workers[0].send({ type: "complete" });
    await replacement;

    expect(library.listGames().total).toBe(61);
    expect(library.listGames("Event 60").games).toHaveLength(1);
    expect(library.listGames("", 50).games).toHaveLength(11);

    await library.clear();
    expect(library.source).toBeNull();
    expect(library.listGames().total).toBe(0);
    const restored = new PersistentMobileLibrary(() => {
      throw new Error("cleared Mobile Library should not scan");
    }, storage);
    await restored.ready();
    expect(restored.source).toBeNull();
    expect(restored.listGames().total).toBe(0);
  });

  it("reports unavailable storage without throwing from initialization", async () => {
    const storage = new MemoryMobileStorage();
    storage.loadError = new Error("IndexedDB is unavailable");
    const library = new PersistentMobileLibrary(() => {
      throw new Error("storage failure should not scan");
    }, storage);

    await expect(library.ready()).resolves.toBeUndefined();
    expect(library.source).toBeNull();
    expect(library.error).toContain("IndexedDB is unavailable");
  });
});

async function completeReplacement(
  library: PersistentMobileLibrary,
  workers: ManualWorker[],
  name: string,
  sourceText: string,
): Promise<void> {
  const replacement = library.replaceSource({ name, blob: new Blob([sourceText]) });
  workers.at(-1)!.send({
    type: "game",
    game: scannedGame(0, sourceText, [["Event", name.replace(/\.pgn$/i, "").replace(/^./, (letter) => letter.toUpperCase())]]),
  });
  workers.at(-1)!.send({ type: "complete" });
  await replacement;
}

function scannedGame(
  index: number,
  sourceText: string,
  headers: Array<[string, string]>,
  warning: string | null = null,
  offsetEnd = new TextEncoder().encode(sourceText).byteLength,
): NonNullable<Extract<MobileScanMessage, { type: "game" }>["game"]> {
  return {
    idxInFile: index,
    offsetStart: 0,
    offsetEnd,
    headers,
    warning,
  };
}

function sizedBlob(size: number): Blob {
  return { size } as Blob;
}

function gameMessage(event: string, opening = ""): MobileScanMessage {
  return {
    type: "game",
    game: {
      idxInFile: Number(event.match(/\d+$/)?.[0] ?? 0),
      offsetStart: 0,
      offsetEnd: 1,
      headers: [
        ["Event", event],
        ["White", `Player ${event.match(/\d+$/)?.[0] ?? 0}`],
        ["Black", "Opponent"],
        ["Opening", opening],
      ],
      warning: null,
    },
  };
}
