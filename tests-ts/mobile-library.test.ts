import { describe, expect, it } from "vitest";

import {
  InMemoryMobileLibrary,
  MOBILE_PAGE_SIZE,
  type MobileScanWorker,
} from "../src/mobile/library.js";
import type { MobileScanMessage, MobileScanRequest } from "../src/mobile/scan-protocol.js";

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
    expect(library.source).toMatchObject({
      name: "study.pgn",
      size: 5,
      scan_status: "scanning",
      game_count: 0,
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

  it("replaces one active source and ignores stale worker messages", () => {
    const workers: ManualWorker[] = [];
    const library = new InMemoryMobileLibrary(() => {
      const worker = new ManualWorker();
      workers.push(worker);
      return worker;
    });

    library.replaceSource({ name: "first.pgn", blob: new Blob(["first"]) });
    workers[0].send(gameMessage("First"));
    library.replaceSource({ name: "second.pgn", blob: new Blob(["second"]) });

    expect(workers[0].terminated).toBe(true);
    workers[0].send(gameMessage("stale"));
    workers[1].send(gameMessage("Second"));
    workers[1].send({ type: "complete" });

    expect(library.source).toMatchObject({
      name: "second.pgn",
      scan_status: "ready",
      game_count: 1,
    });
    expect(library.listGames().games.map((game) => game.event)).toEqual(["Second"]);
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
});

function gameMessage(event: string, opening = ""): MobileScanMessage {
  return {
    type: "game",
    game: {
      idxInFile: Number(event.match(/\d+$/)?.[0] ?? 0),
      offsetStart: 0,
      offsetEnd: 10,
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
