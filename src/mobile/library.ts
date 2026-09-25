import { BlobSource } from "../browser-source.js";
import { hydrateGame } from "../hydration.js";
import type { ScannedGame } from "../scan.js";
import type { MobileScanMessage, MobileScanRequest } from "./scan-protocol.js";
import type { GameDocument } from "../wire.js";
import {
  IndexedDbMobileStorage,
  type MobileLibrarySnapshot,
  type MobileLibraryStorage,
} from "./storage.js";

export const MOBILE_PAGE_SIZE = 50;
export const MOBILE_MAX_SOURCE_BYTES = 50 * 1024 * 1024;
export const MOBILE_MAX_GAME_BYTES = 8 * 1024 * 1024;

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

export type MobileReplacementStatus = {
  name: string;
  size: number;
  scan_status: "scanning" | "committing";
  progress: MobileScanProgress;
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
  readonly error: string | null;
  readonly replacement: MobileReplacementStatus | null;

  ready(): Promise<void>;
  replaceSource(source: MobileSourceInput): Promise<void>;
  clear(): Promise<void>;
  cancelReplacement(): void;
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

  get error(): string | null {
    return this.currentSource?.scan_error ?? null;
  }

  get replacement(): MobileReplacementStatus | null {
    return null;
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  replaceSource(source: MobileSourceInput): Promise<void> {
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
      return Promise.resolve();
    }

    let worker: MobileScanWorker;
    try {
      worker = this.workerFactory();
    } catch (error) {
      this.fail(generation, errorMessage(error));
      return Promise.resolve();
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
    return Promise.resolve();
  }

  async clear(): Promise<void> {
    this.generation += 1;
    this.stopActiveWorker();
    this.currentSource = null;
    this.currentBlob = null;
    this.games = [];
    this.emit();
  }

  cancelReplacement(): void {
    this.generation += 1;
    this.stopActiveWorker();
  }

  listGames(query = "", offset = 0, limit = MOBILE_PAGE_SIZE): MobileGamePage {
    return listMobileGames(this.games, query, offset, limit);
  }

  getGameDocument(gameId: number): Promise<GameDocument> {
    return getMobileGameDocument(this.currentBlob, this.currentSource, this.games, gameId);
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

type PendingMobileReplacement = {
  input: MobileSourceInput;
  games: MobileGameEntry[];
  worker: MobileScanWorker | null;
  phase: "scanning" | "committing";
  progress: MobileScanProgress;
  completion: Promise<void>;
  resolve: () => void;
};

export class PersistentMobileLibrary implements MobileLibrary {
  private currentSource: MobileSourceRecord | null = null;
  private currentBlob: Blob | null = null;
  private games: MobileGameEntry[] = [];
  private pending: PendingMobileReplacement | null = null;
  private lastError: string | null = null;
  private initialized = false;
  private readonly initialization: Promise<void>;
  private readonly listeners = new Set<MobileLibraryListener>();

  constructor(
    private readonly workerFactory: MobileScanWorkerFactory,
    private readonly storage: MobileLibraryStorage = new IndexedDbMobileStorage(),
  ) {
    this.initialization = this.restore();
  }

  get source(): MobileSourceRecord | null {
    return this.currentSource ? copySource(this.currentSource) : null;
  }

  get error(): string | null {
    return this.lastError;
  }

  get replacement(): MobileReplacementStatus | null {
    if (!this.pending) return null;
    return {
      name: this.pending.input.name || "Untitled source",
      size: this.pending.input.blob.size,
      scan_status: this.pending.phase,
      progress: { ...this.pending.progress },
    };
  }

  ready(): Promise<void> {
    return this.initialization;
  }

  replaceSource(source: MobileSourceInput): Promise<void> {
    if (!this.initialized) {
      return this.initialization.then(() => this.replaceSource(source));
    }
    if (this.pending?.phase === "committing") {
      return this.pending.completion.then(() => this.replaceSource(source));
    }
    this.cancelPending();
    return this.startReplacement(source);
  }

  clear(): Promise<void> {
    if (!this.initialized) return this.initialization.then(() => this.clear());
    if (this.pending?.phase === "committing") {
      return this.pending.completion.then(() => this.clear());
    }
    this.cancelPending();
    return this.clearStoredSource();
  }

  cancelReplacement(): void {
    this.cancelPending("Source replacement cancelled.");
  }

  listGames(query = "", offset = 0, limit = MOBILE_PAGE_SIZE): MobileGamePage {
    return listMobileGames(this.games, query, offset, limit);
  }

  getGameDocument(gameId: number): Promise<GameDocument> {
    return getMobileGameDocument(this.currentBlob, this.currentSource, this.games, gameId);
  }

  subscribe(listener: MobileLibraryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.cancelPending();
    this.listeners.clear();
  }

  private async restore(): Promise<void> {
    try {
      const snapshot = await this.storage.load();
      if (snapshot) this.restoreSnapshot(snapshot);
    } catch (error) {
      this.currentSource = null;
      this.currentBlob = null;
      this.games = [];
      this.lastError = errorMessage(error);
    } finally {
      this.initialized = true;
      this.emit();
    }
  }

  private restoreSnapshot(snapshot: MobileLibrarySnapshot): void {
    if (snapshot.sourceBytes.byteLength !== snapshot.source.size ||
      snapshot.source.game_count !== snapshot.games.length ||
      snapshot.source.warning_count !== snapshot.games.filter(({ record }) => record.warning !== null).length) {
      throw new Error("Stored Mobile Library data is invalid.");
    }
    for (const entry of snapshot.games) {
      const span = entry.scanned.offsetEnd - entry.scanned.offsetStart;
      if (entry.scanned.offsetEnd > snapshot.source.size || span > MOBILE_MAX_GAME_BYTES) {
        throw new Error("Stored Mobile Library data contains an unsafe Game record span.");
      }
    }

    this.currentSource = copySource(snapshot.source);
    this.currentBlob = new Blob([snapshot.sourceBytes.slice(0)]);
    this.games = snapshot.games.map(copyGameEntry);
  }

  private startReplacement(source: MobileSourceInput): Promise<void> {
    this.lastError = null;
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });

    const name = source.name || "Untitled source";
    if (!name.toLowerCase().endsWith(".pgn")) {
      this.failWithoutReplacement("Choose a source whose name ends in .pgn.", resolveCompletion);
      return completion;
    }
    if (!Number.isSafeInteger(source.blob.size) || source.blob.size > MOBILE_MAX_SOURCE_BYTES) {
      this.failWithoutReplacement(
        "This PGN source is too large. The maximum supported source size is 50 MiB.",
        resolveCompletion,
      );
      return completion;
    }

    const pending: PendingMobileReplacement = {
      input: source,
      games: [],
      worker: null,
      phase: "scanning",
      progress: {
        bytesDone: 0,
        bytesTotal: source.blob.size,
        gamesFound: 0,
      },
      completion,
      resolve: resolveCompletion,
    };
    this.pending = pending;
    this.emit();

    let worker: MobileScanWorker;
    try {
      worker = this.workerFactory();
    } catch (error) {
      this.failPending(pending, errorMessage(error));
      return completion;
    }

    pending.worker = worker;
    worker.onmessage = (event) => this.receive(pending, worker, event.data);
    worker.onerror = (event) => this.failPending(pending, event.message || "Scan worker failed.");
    try {
      worker.postMessage({ type: "scan", source: source.blob });
    } catch (error) {
      this.failPending(pending, errorMessage(error));
    }
    return completion;
  }

  private receive(
    pending: PendingMobileReplacement,
    worker: MobileScanWorker,
    message: MobileScanMessage,
  ): void {
    if (this.pending !== pending || pending.worker !== worker || pending.phase !== "scanning") return;

    if (message.type === "game") {
      const span = message.game.offsetEnd - message.game.offsetStart;
      if (!validGameSpan(message.game, pending.input.blob.size)) {
        this.failPending(pending, "The source contains an unreadable Game record span.");
        return;
      }
      if (span > MOBILE_MAX_GAME_BYTES) {
        this.failPending(
          pending,
          "A Game record exceeds the 8 MiB safety limit. The previous source is still active.",
        );
        return;
      }
      const record = projectGameRecord(message.game);
      pending.games.push({ scanned: message.game, record });
      pending.progress.gamesFound = pending.games.length;
      this.emit();
      return;
    }

    if (message.type === "progress") {
      pending.progress = {
        bytesDone: Math.min(Math.max(0, message.bytesDone), pending.input.blob.size),
        bytesTotal: pending.input.blob.size,
        gamesFound: Math.max(pending.games.length, message.gamesFound),
      };
      this.emit();
      return;
    }

    if (message.type === "complete") {
      pending.phase = "committing";
      pending.progress = {
        bytesDone: pending.input.blob.size,
        bytesTotal: pending.input.blob.size,
        gamesFound: pending.games.length,
      };
      pending.worker = null;
      worker.terminate();
      this.emit();
      void this.commit(pending);
      return;
    }

    this.failPending(pending, message.error);
  }

  private async commit(pending: PendingMobileReplacement): Promise<void> {
    try {
      const sourceBytes = await readBlobBytes(pending.input.blob);
      const source = readySourceRecord(pending.input.name, sourceBytes.byteLength, pending.games);
      const snapshot: MobileLibrarySnapshot = {
        schemaVersion: 1,
        source,
        sourceBytes,
        games: pending.games.map(copyGameEntry),
      };
      await this.storage.save(snapshot);

      if (this.pending !== pending) return;
      this.currentSource = source;
      this.currentBlob = new Blob([sourceBytes.slice(0)]);
      this.games = pending.games;
      this.pending = null;
      this.lastError = null;
      this.emit();
    } catch (error) {
      if (this.pending === pending) {
        this.pending = null;
        this.lastError = errorMessage(error);
        this.emit();
      }
    } finally {
      pending.resolve();
    }
  }

  private async clearStoredSource(): Promise<void> {
    try {
      await this.storage.clear();
      this.currentSource = null;
      this.currentBlob = null;
      this.games = [];
      this.lastError = null;
      this.emit();
    } catch (error) {
      this.lastError = errorMessage(error);
      this.emit();
    }
  }

  private failWithoutReplacement(message: string, resolve: () => void): void {
    this.lastError = message;
    this.emit();
    resolve();
  }

  private failPending(pending: PendingMobileReplacement, message: string): void {
    if (this.pending !== pending || pending.phase !== "scanning") return;
    this.pending = null;
    const worker = pending.worker;
    pending.worker = null;
    if (worker) worker.terminate();
    this.lastError = message;
    this.emit();
    pending.resolve();
  }

  private cancelPending(message?: string): void {
    const pending = this.pending;
    if (!pending || pending.phase !== "scanning") return;
    this.pending = null;
    const worker = pending.worker;
    pending.worker = null;
    if (worker) worker.terminate();
    if (message) this.lastError = message;
    pending.resolve();
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function listMobileGames(
  entries: MobileGameEntry[],
  query: string,
  offset: number,
  limit: number,
): MobileGamePage {
  const search = query.trim().toLowerCase();
  const matching = search
    ? entries.filter(({ record }) => searchableFields(record).some((field) => field.includes(search)))
    : entries;
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

async function getMobileGameDocument(
  source: Blob | null,
  sourceRecord: MobileSourceRecord | null,
  games: MobileGameEntry[],
  gameId: number,
): Promise<GameDocument> {
  const entry = games.find(({ record }) => record.id === gameId);
  if (!source || !sourceRecord) throw new Error("no PGN source selected");
  if (!entry) throw new Error(`Game record ${gameId} was not found`);

  const sourceBytes = await new BlobSource(source).readSpan(
    entry.scanned.offsetStart,
    entry.scanned.offsetEnd,
    MOBILE_MAX_GAME_BYTES,
  );
  const extraWarnings = entry.record.warning ? [`index warning: ${entry.record.warning}`] : [];
  const payload = hydrateGame(sourceBytes, entry.scanned.headers, extraWarnings);
  const index = games.indexOf(entry);

  return {
    ...payload,
    gameId: entry.record.id,
    fileId: 1,
    fileName: sourceRecord.name,
    idxInFile: entry.record.idx_in_file,
    neighbors: {
      prev: index > 0 ? games[index - 1].record.id : null,
      next: index + 1 < games.length ? games[index + 1].record.id : null,
    },
  };
}

function validGameSpan(game: ScannedGame, sourceSize: number): boolean {
  return Number.isSafeInteger(game.offsetStart) &&
    Number.isSafeInteger(game.offsetEnd) &&
    game.offsetStart >= 0 &&
    game.offsetEnd >= game.offsetStart &&
    game.offsetEnd <= sourceSize;
}

function readySourceRecord(
  name: string,
  size: number,
  games: MobileGameEntry[],
): MobileSourceRecord {
  return {
    name: name || "Untitled source",
    size,
    game_count: games.length,
    warning_count: games.filter(({ record }) => record.warning !== null).length,
    scan_status: "ready",
    scan_error: null,
    progress: {
      bytesDone: size,
      bytesTotal: size,
      gamesFound: games.length,
    },
  };
}

async function readBlobBytes(blob: Blob): Promise<ArrayBuffer> {
  let bytes: ArrayBuffer;
  try {
    bytes = await blob.arrayBuffer();
  } catch {
    throw new Error("The selected PGN source could not be read.");
  }
  if (bytes.byteLength !== blob.size) {
    throw new Error("The selected PGN source could not be read completely.");
  }
  return bytes;
}

function copyGameEntry(entry: MobileGameEntry): MobileGameEntry {
  return {
    scanned: {
      ...entry.scanned,
      headers: entry.scanned.headers.map(([name, value]) => [name, value] as [string, string]),
    },
    record: { ...entry.record },
  };
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
