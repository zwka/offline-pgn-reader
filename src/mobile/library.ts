import { BlobSource } from "../browser-source.js";
import { hydrateGame } from "../hydration.js";
import type { ScannedGame } from "../scan.js";
import type { MobileScanMessage, MobileScanRequest } from "./scan-protocol.js";
import type { GameDocument } from "../wire.js";

export const MOBILE_PAGE_SIZE = 50;
const MOBILE_MAX_GAME_BYTES = 8 * 1024 * 1024;

export type MobileScanStatus = "pending" | "scanning" | "ready" | "error";

export type MobileScanProgress = {
  bytesDone: number;
  bytesTotal: number;
  gamesFound: number;
};

export type MobileSourceRecord = {
  name: string;
  size: number;
  game_count: number;
  warning_count: number;
  scan_status: MobileScanStatus;
  scan_error: string | null;
  progress: MobileScanProgress | null;
};

export type MobileSourceInput = {
  name: string;
  blob: Blob;
};

export type MobileGameRecord = {
  id: number;
  idx_in_file: number;
  event: string;
  site: string;
  date: string;
  round: string;
  white: string;
  black: string;
  result: string;
  eco: string;
  opening: string;
  has_fen: number;
  warning: string | null;
  byte_size: number;
};

export type MobileGamePage = {
  total: number;
  offset: number;
  limit: number;
  games: MobileGameRecord[];
};

export type MobileScanWorker = {
  onmessage: ((event: MessageEvent<MobileScanMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: MobileScanRequest): void;
  terminate(): void;
};

export type MobileScanWorkerFactory = () => MobileScanWorker;
export type MobileLibraryListener = () => void;

type MobileGameEntry = {
  scanned: ScannedGame;
  record: MobileGameRecord;
};

export interface MobileLibrary {
  readonly source: MobileSourceRecord | null;

  replaceSource(source: MobileSourceInput): void;
  listGames(query?: string, offset?: number, limit?: number): MobileGamePage;
  getGameDocument(gameId: number): Promise<GameDocument>;
  subscribe(listener: MobileLibraryListener): () => void;
  close(): void;
}

export class InMemoryMobileLibrary implements MobileLibrary {
  private currentSource: MobileSourceRecord | null = null;
  private currentBlob: Blob | null = null;
  private games: MobileGameEntry[] = [];
  private activeWorker: MobileScanWorker | null = null;
  private generation = 0;
  private readonly listeners = new Set<MobileLibraryListener>();

  constructor(private readonly workerFactory: MobileScanWorkerFactory) {}

  get source(): MobileSourceRecord | null {
    return this.currentSource ? copySource(this.currentSource) : null;
  }

  replaceSource(source: MobileSourceInput): void {
    this.stopActiveWorker();
    const generation = ++this.generation;
    this.currentBlob = source.blob;
    this.games = [];

    const initial: MobileSourceRecord = {
      name: source.name || "Untitled source",
      size: source.blob.size,
      game_count: 0,
      warning_count: 0,
      scan_status: "pending",
      scan_error: null,
      progress: {
        bytesDone: 0,
        bytesTotal: source.blob.size,
        gamesFound: 0,
      },
    };
    this.currentSource = initial;
    this.emit();

    if (!source.name.toLowerCase().endsWith(".pgn")) {
      this.fail(generation, "Choose a source whose name ends in .pgn.");
      return;
    }

    let worker: MobileScanWorker;
    try {
      worker = this.workerFactory();
    } catch (error) {
      this.fail(generation, errorMessage(error));
      return;
    }

    this.activeWorker = worker;
    worker.onmessage = (event) => this.receive(generation, worker, event.data);
    worker.onerror = (event) => this.fail(generation, event.message || "Scan worker failed.");
    this.currentSource = {
      ...initial,
      scan_status: "scanning",
    };
    this.emit();

    try {
      worker.postMessage({ type: "scan", source: source.blob });
    } catch (error) {
      this.fail(generation, errorMessage(error));
    }
  }

  listGames(query = "", offset = 0, limit = MOBILE_PAGE_SIZE): MobileGamePage {
    const search = query.trim().toLowerCase();
    const matching = search
      ? this.games.filter(({ record }) => searchableFields(record).some((field) => field.includes(search)))
      : this.games;
    const normalizedOffset = Math.max(0, Math.trunc(offset));
    const normalizedLimit = Math.min(
      MOBILE_PAGE_SIZE,
      Math.max(1, Math.trunc(limit)),
    );
    return {
      total: matching.length,
      offset: normalizedOffset,
      limit: normalizedLimit,
      games: matching
        .slice(normalizedOffset, normalizedOffset + normalizedLimit)
        .map(({ record }) => record),
    };
  }

  async getGameDocument(gameId: number): Promise<GameDocument> {
    const source = this.currentBlob;
    const sourceRecord = this.currentSource;
    const entry = this.games.find(({ record }) => record.id === gameId);
    if (!source || !sourceRecord) throw new Error("no PGN source selected");
    if (!entry) throw new Error(`Game record ${gameId} was not found`);

    const sourceBytes = await new BlobSource(source).readSpan(
      entry.scanned.offsetStart,
      entry.scanned.offsetEnd,
      MOBILE_MAX_GAME_BYTES,
    );
    const extraWarnings = entry.record.warning ? [`index warning: ${entry.record.warning}`] : [];
    const payload = hydrateGame(sourceBytes, entry.scanned.headers, extraWarnings);
    const index = this.games.indexOf(entry);

    return {
      ...payload,
      gameId: entry.record.id,
      fileId: 1,
      fileName: sourceRecord.name,
      idxInFile: entry.record.idx_in_file,
      neighbors: {
        prev: index > 0 ? this.games[index - 1].record.id : null,
        next: index + 1 < this.games.length ? this.games[index + 1].record.id : null,
      },
    };
  }

  subscribe(listener: MobileLibraryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.generation += 1;
    this.stopActiveWorker();
    this.currentBlob = null;
    this.listeners.clear();
  }

  private receive(
    generation: number,
    worker: MobileScanWorker,
    message: MobileScanMessage,
  ): void {
    if (generation !== this.generation || worker !== this.activeWorker || !this.currentSource) return;

    if (message.type === "game") {
      const record = projectGameRecord(message.game);
      this.games.push({ scanned: message.game, record });
      this.currentSource = {
        ...this.currentSource,
        game_count: this.games.length,
        warning_count: this.currentSource.warning_count + (record.warning ? 1 : 0),
      };
      this.emit();
      return;
    }

    if (message.type === "progress") {
      this.currentSource = {
        ...this.currentSource,
        game_count: Math.max(this.games.length, message.gamesFound),
        progress: {
          bytesDone: Math.min(message.bytesDone, this.currentSource.size),
          bytesTotal: this.currentSource.size,
          gamesFound: Math.max(this.games.length, message.gamesFound),
        },
      };
      this.emit();
      return;
    }

    if (message.type === "complete") {
      this.currentSource = {
        ...this.currentSource,
        game_count: this.games.length,
        scan_status: "ready",
        scan_error: null,
        progress: {
          bytesDone: this.currentSource.size,
          bytesTotal: this.currentSource.size,
          gamesFound: this.games.length,
        },
      };
      this.activeWorker = null;
      worker.terminate();
      this.emit();
      return;
    }

    this.fail(generation, message.error);
  }

  private fail(generation: number, message: string): void {
    if (generation !== this.generation || !this.currentSource) return;
    const worker = this.activeWorker;
    this.activeWorker = null;
    if (worker) worker.terminate();
    this.currentSource = {
      ...this.currentSource,
      scan_status: "error",
      scan_error: message,
    };
    this.emit();
  }

  private stopActiveWorker(): void {
    const worker = this.activeWorker;
    this.activeWorker = null;
    if (worker) worker.terminate();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function projectGameRecord(game: ScannedGame): MobileGameRecord {
  return {
    id: game.idxInFile + 1,
    idx_in_file: game.idxInFile,
    event: lastTagValue(game.headers, "Event"),
    site: lastTagValue(game.headers, "Site"),
    date: lastTagValue(game.headers, "Date"),
    round: lastTagValue(game.headers, "Round"),
    white: lastTagValue(game.headers, "White"),
    black: lastTagValue(game.headers, "Black"),
    result: lastTagValue(game.headers, "Result"),
    eco: lastTagValue(game.headers, "ECO"),
    opening: lastTagValue(game.headers, "Opening"),
    has_fen: game.headers.some(([name]) => name === "FEN") ? 1 : 0,
    warning: game.warning,
    byte_size: game.offsetEnd - game.offsetStart,
  };
}

function lastTagValue(headers: ScannedGame["headers"], name: string): string {
  let value = "";
  for (const [tagName, tagValue] of headers) {
    if (tagName === name) value = tagValue;
  }
  return value;
}

function searchableFields(game: MobileGameRecord): string[] {
  return [
    game.white,
    game.black,
    game.event,
    game.site,
    game.date,
    game.round,
    game.result,
    game.eco,
    game.opening,
  ].map((value) => value.toLowerCase());
}

function copySource(source: MobileSourceRecord): MobileSourceRecord {
  return {
    ...source,
    progress: source.progress ? { ...source.progress } : null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
