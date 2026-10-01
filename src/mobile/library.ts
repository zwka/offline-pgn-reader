import { BlobSource } from "../browser-source.js";
import { hydrateGame } from "../hydration.js";
import type { ScannedGame } from "../scan.js";
import type { MobileScanMessage, MobileScanRequest } from "./scan-protocol.js";
import type { GameDocument } from "../wire.js";
import {
  IndexedDbMobileStorage,
  MOBILE_LEGACY_STORAGE_SCHEMA_VERSION,
  type MobileLibrarySnapshot,
  type MobileLibraryStorage,
  type MobileStoredSnapshot,
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
  id: number;
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

type MobileSourceState = {
  source: MobileSourceRecord;
  blob: Blob;
  bytes?: ArrayBuffer;
  games: MobileGameEntry[];
};

export interface MobileLibrary {
  readonly sources: MobileSourceRecord[];
  readonly activeSourceId: number | null;
  readonly source: MobileSourceRecord | null;
  readonly error: string | null;
  readonly replacement: MobileReplacementStatus | null;

  ready(): Promise<void>;
  replaceSource(source: MobileSourceInput): Promise<void>;
  selectSource(sourceId: number): Promise<void>;
  removeSource(sourceId: number): Promise<void>;
  clear(): Promise<void>;
  cancelReplacement(): void;
  listGames(query?: string, offset?: number, limit?: number): MobileGamePage;
  getGameDocument(gameId: number): Promise<GameDocument>;
  subscribe(listener: MobileLibraryListener): () => void;
  close(): void;
}

export class InMemoryMobileLibrary implements MobileLibrary {
  private readonly sourceStates = new Map<number, MobileSourceState>();
  private currentSourceId: number | null = null;
  private pending: PendingMobileReplacement | null = null;
  private lastError: string | null = null;
  private readonly listeners = new Set<MobileLibraryListener>();

  constructor(private readonly workerFactory: MobileScanWorkerFactory) {}

  get sources(): MobileSourceRecord[] {
    return sortedSources(this.sourceStates.values());
  }

  get activeSourceId(): number | null {
    return this.currentSourceId;
  }

  get source(): MobileSourceRecord | null {
    const state = this.currentSourceId === null ? undefined : this.sourceStates.get(this.currentSourceId);
    return state ? copySource(state.source) : null;
  }

  get error(): string | null {
    return this.lastError;
  }

  get replacement(): MobileReplacementStatus | null {
    return replacementStatus(this.pending);
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  replaceSource(source: MobileSourceInput): Promise<void> {
    this.cancelPending();
    this.lastError = null;
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    if (!source.name.toLowerCase().endsWith(".pgn")) {
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
      sourceId: nextSourceId(this.sourceStates.values()),
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

  selectSource(sourceId: number): Promise<void> {
    if (!this.sourceStates.has(sourceId)) return Promise.resolve();
    if (this.currentSourceId === sourceId) return Promise.resolve();
    this.currentSourceId = sourceId;
    this.lastError = null;
    this.emit();
    return Promise.resolve();
  }

  removeSource(sourceId: number): Promise<void> {
    if (!this.sourceStates.delete(sourceId)) return Promise.resolve();
    if (this.currentSourceId === sourceId) this.currentSourceId = null;
    this.lastError = null;
    this.emit();
    return Promise.resolve();
  }

  clear(): Promise<void> {
    return this.currentSourceId === null
      ? Promise.resolve()
      : this.removeSource(this.currentSourceId);
  }

  cancelReplacement(): void {
    this.cancelPending("Source import cancelled.");
  }

  listGames(query = "", offset = 0, limit = MOBILE_PAGE_SIZE): MobileGamePage {
    return listMobileGames(activeGames(this.sourceStates, this.currentSourceId), query, offset, limit);
  }

  getGameDocument(gameId: number): Promise<GameDocument> {
    const state = this.currentSourceId === null ? undefined : this.sourceStates.get(this.currentSourceId);
    return getMobileGameDocument(state?.blob ?? null, state?.source ?? null, state?.games ?? [], gameId);
  }

  subscribe(listener: MobileLibraryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.cancelPending();
    this.listeners.clear();
  }

  private receive(pending: PendingMobileReplacement, worker: MobileScanWorker, message: MobileScanMessage): void {
    if (this.pending !== pending || pending.worker !== worker || pending.phase !== "scanning") return;

    if (message.type === "game") {
      const span = message.game.offsetEnd - message.game.offsetStart;
      if (!validGameSpan(message.game, pending.input.blob.size)) {
        this.failPending(pending, "The source contains an unreadable Game record span.");
        return;
      }
      if (span > MOBILE_MAX_GAME_BYTES) {
        this.failPending(pending, "A Game record exceeds the 8 MiB safety limit.");
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
      const games = assignGameIds(pending.games, nextGameId(this.sourceStates.values()));
      const source = readySourceRecord(pending.sourceId, pending.input.name, pending.input.blob.size, games);
      this.sourceStates.set(pending.sourceId, { source, blob: pending.input.blob, games });
      this.currentSourceId = pending.sourceId;
      this.pending = null;
      pending.resolve();
      this.emit();
      return;
    }

    this.failPending(pending, message.error);
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
    pending.resolve();
    this.emit();
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

type PendingMobileReplacement = {
  input: MobileSourceInput;
  sourceId: number;
  games: MobileGameEntry[];
  worker: MobileScanWorker | null;
  phase: "scanning" | "committing";
  progress: MobileScanProgress;
  completion: Promise<void>;
  resolve: () => void;
};

export class PersistentMobileLibrary implements MobileLibrary {
  private sourceStates = new Map<number, MobileSourceState>();
  private currentSourceId: number | null = null;
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

  get sources(): MobileSourceRecord[] {
    return sortedSources(this.sourceStates.values());
  }

  get activeSourceId(): number | null {
    return this.currentSourceId;
  }

  get source(): MobileSourceRecord | null {
    const state = this.currentSourceId === null ? undefined : this.sourceStates.get(this.currentSourceId);
    return state ? copySource(state.source) : null;
  }

  get error(): string | null {
    return this.lastError;
  }

  get replacement(): MobileReplacementStatus | null {
    return replacementStatus(this.pending);
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

  selectSource(sourceId: number): Promise<void> {
    if (!this.initialized) return this.initialization.then(() => this.selectSource(sourceId));
    if (this.pending?.phase === "committing") {
      return this.pending.completion.then(() => this.selectSource(sourceId));
    }
    if (!this.sourceStates.has(sourceId) || this.currentSourceId === sourceId) return Promise.resolve();
    return this.persistSelection(sourceId);
  }

  removeSource(sourceId: number): Promise<void> {
    if (!this.initialized) return this.initialization.then(() => this.removeSource(sourceId));
    if (this.pending?.phase === "committing") {
      return this.pending.completion.then(() => this.removeSource(sourceId));
    }
    this.cancelPending();
    return this.removeStoredSource(sourceId);
  }

  clear(): Promise<void> {
    if (!this.initialized) return this.initialization.then(() => this.clear());
    if (this.pending?.phase === "committing") {
      return this.pending.completion.then(() => this.clear());
    }
    this.cancelPending();
    return this.currentSourceId === null
      ? Promise.resolve()
      : this.removeStoredSource(this.currentSourceId);
  }

  cancelReplacement(): void {
    this.cancelPending("Source import cancelled.");
  }

  listGames(query = "", offset = 0, limit = MOBILE_PAGE_SIZE): MobileGamePage {
    return listMobileGames(activeGames(this.sourceStates, this.currentSourceId), query, offset, limit);
  }

  getGameDocument(gameId: number): Promise<GameDocument> {
    const state = this.currentSourceId === null ? undefined : this.sourceStates.get(this.currentSourceId);
    return getMobileGameDocument(state?.blob ?? null, state?.source ?? null, state?.games ?? [], gameId);
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
      if (snapshot) {
        const migrated = migrateSnapshot(snapshot);
        this.restoreSnapshot(migrated);
        if (snapshot.schemaVersion === MOBILE_LEGACY_STORAGE_SCHEMA_VERSION) {
          try {
            await this.storage.save(migrated);
          } catch (error) {
            this.lastError = errorMessage(error);
          }
        }
      }
    } catch (error) {
      this.sourceStates.clear();
      this.currentSourceId = null;
      this.lastError = errorMessage(error);
    } finally {
      this.initialized = true;
      this.emit();
    }
  }

  private restoreSnapshot(snapshot: MobileLibrarySnapshot): void {
    const sourceIds = new Set<number>();
    const gameIds = new Set<number>();
    const states = new Map<number, MobileSourceState>();
    for (const persisted of snapshot.sources) {
      validatePersistedSource(persisted);
      if (sourceIds.has(persisted.source.id)) throw new Error("Stored Mobile Library data has duplicate source ids.");
      sourceIds.add(persisted.source.id);
      for (const entry of persisted.games) {
        if (gameIds.has(entry.record.id)) throw new Error("Stored Mobile Library data has duplicate Game record ids.");
        gameIds.add(entry.record.id);
      }
      const bytes = persisted.sourceBytes.slice(0);
      states.set(persisted.source.id, {
        source: copySource(persisted.source),
        blob: new Blob([bytes.slice(0)]),
        bytes,
        games: persisted.games.map(copyGameEntry),
      });
    }
    if (snapshot.activeSourceId !== null && !states.has(snapshot.activeSourceId)) {
      throw new Error("Stored Mobile Library data has no active source.");
    }
    this.sourceStates = states;
    this.currentSourceId = snapshot.activeSourceId;
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
      sourceId: nextSourceId(this.sourceStates.values()),
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
      const games = assignGameIds(pending.games, nextGameId(this.sourceStates.values()));
      const source = readySourceRecord(pending.sourceId, pending.input.name, sourceBytes.byteLength, games);
      const candidate = new Map(this.sourceStates);
      candidate.set(pending.sourceId, {
        source,
        blob: pending.input.blob,
        bytes: sourceBytes,
        games,
      });
      const snapshot = await snapshotForStates(candidate, pending.sourceId);
      await this.storage.save(snapshot);

      if (this.pending !== pending) return;
      this.sourceStates = candidate;
      this.currentSourceId = pending.sourceId;
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

  private async persistSelection(sourceId: number): Promise<void> {
    try {
      await this.storage.save(await snapshotForStates(this.sourceStates, sourceId));
      this.currentSourceId = sourceId;
      this.lastError = null;
      this.emit();
    } catch (error) {
      this.lastError = errorMessage(error);
      this.emit();
    }
  }

  private async removeStoredSource(sourceId: number): Promise<void> {
    if (!this.sourceStates.has(sourceId)) return;
    const candidate = new Map(this.sourceStates);
    candidate.delete(sourceId);
    const activeSourceId = this.currentSourceId === sourceId ? null : this.currentSourceId;
    try {
      await this.storage.save(await snapshotForStates(candidate, activeSourceId));
      this.sourceStates = candidate;
      this.currentSourceId = activeSourceId;
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

function activeGames(
  states: Map<number, MobileSourceState>,
  sourceId: number | null,
): MobileGameEntry[] {
  return sourceId === null ? [] : states.get(sourceId)?.games ?? [];
}

function sortedSources(states: Iterable<MobileSourceState>): MobileSourceRecord[] {
  return sortedStates(states).map(({ source }) => copySource(source));
}

function sortedStates(states: Iterable<MobileSourceState>): MobileSourceState[] {
  return [...states].sort((left, right) => compareSources(left.source, right.source));
}

function compareSources(left: MobileSourceRecord, right: MobileSourceRecord): number {
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) || left.id - right.id;
}

function replacementStatus(pending: PendingMobileReplacement | null): MobileReplacementStatus | null {
  if (!pending) return null;
  return {
    name: pending.input.name || "Untitled source",
    size: pending.input.blob.size,
    scan_status: pending.phase,
    progress: { ...pending.progress },
  };
}

function nextSourceId(states: Iterable<MobileSourceState>): number {
  let maximum = 0;
  for (const { source } of states) maximum = Math.max(maximum, source.id);
  if (maximum === Number.MAX_SAFE_INTEGER) throw new Error("The Mobile Library has reached its source limit.");
  return maximum + 1;
}

function nextGameId(states: Iterable<MobileSourceState>): number {
  let maximum = 0;
  for (const state of states) {
    for (const { record } of state.games) maximum = Math.max(maximum, record.id);
  }
  if (maximum === Number.MAX_SAFE_INTEGER) throw new Error("The Mobile Library has reached its Game record limit.");
  return maximum + 1;
}

function assignGameIds(entries: MobileGameEntry[], firstId: number): MobileGameEntry[] {
  return entries.map((entry, index) => {
    const id = firstId + index;
    if (!Number.isSafeInteger(id)) throw new Error("The Mobile Library has reached its Game record limit.");
    return {
      scanned: {
        ...entry.scanned,
        headers: entry.scanned.headers.map(([name, value]) => [name, value] as [string, string]),
      },
      record: { ...entry.record, id },
    };
  });
}

async function snapshotForStates(
  states: Map<number, MobileSourceState>,
  activeSourceId: number | null,
): Promise<MobileLibrarySnapshot> {
  const sources = [];
  for (const state of sortedStates(states.values())) {
    const sourceBytes = state.bytes?.slice(0) ?? await readBlobBytes(state.blob);
    sources.push({
      source: copySource(state.source),
      sourceBytes,
      games: state.games.map(copyGameEntry),
    });
  }
  return {
    schemaVersion: 2,
    activeSourceId,
    sources,
  };
}

function migrateSnapshot(snapshot: MobileStoredSnapshot): MobileLibrarySnapshot {
  if (snapshot.schemaVersion !== MOBILE_LEGACY_STORAGE_SCHEMA_VERSION) return snapshot;
  return {
    schemaVersion: 2,
    activeSourceId: 1,
    sources: [{
      source: { id: 1, ...snapshot.source },
      sourceBytes: snapshot.sourceBytes.slice(0),
      games: snapshot.games.map(copyGameEntry),
    }],
  };
}

function validatePersistedSource(
  persisted: MobileLibrarySnapshot["sources"][number],
): void {
  const { source, sourceBytes, games } = persisted;
  if (!Number.isSafeInteger(source.id) || source.id <= 0 ||
    sourceBytes.byteLength !== source.size || source.size > MOBILE_MAX_SOURCE_BYTES ||
    source.game_count !== games.length ||
    source.warning_count !== games.filter(({ record }) => record.warning !== null).length) {
    throw new Error("Stored Mobile Library data is invalid.");
  }
  for (const entry of games) {
    const span = entry.scanned.offsetEnd - entry.scanned.offsetStart;
    if (!validGameSpan(entry.scanned, source.size) || span > MOBILE_MAX_GAME_BYTES ||
      entry.record.idx_in_file !== entry.scanned.idxInFile || entry.record.byte_size !== span) {
      throw new Error("Stored Mobile Library data contains an unsafe Game record span.");
    }
  }
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
    fileId: sourceRecord.id,
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
  id: number,
  name: string,
  size: number,
  games: MobileGameEntry[],
): MobileSourceRecord {
  return {
    id,
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

function projectGameRecord(game: ScannedGame, id = game.idxInFile + 1): MobileGameRecord {
  return {
    id,
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
