import type { ScannedGame } from "../scan.js";
import type { MobileGameRecord, MobileSourceRecord } from "./library.js";

export const MOBILE_LEGACY_STORAGE_SCHEMA_VERSION = 1;
export const MOBILE_MULTI_SOURCE_STORAGE_SCHEMA_VERSION = 2;
export const MOBILE_STORAGE_SCHEMA_VERSION = 3;

const DEFAULT_DATABASE_NAME = "offline-pgn-reader-mobile";
const STORE_NAME = "library";
const ACTIVE_RECORD_KEY = "active";

export type MobilePersistedGame = {
  scanned: ScannedGame;
  record: MobileGameRecord;
};

export type MobilePersistedSource = {
  source: MobileSourceRecord;
  sourceBytes: ArrayBuffer;
  games: MobilePersistedGame[];
};

export type MobileLibrarySnapshot = {
  schemaVersion: typeof MOBILE_STORAGE_SCHEMA_VERSION;
  activeSourceId: number | null;
  sources: MobilePersistedSource[];
};

export type MobileMultiSourceLibrarySnapshot = {
  schemaVersion: typeof MOBILE_MULTI_SOURCE_STORAGE_SCHEMA_VERSION;
  activeSourceId: number | null;
  sources: MobilePersistedMultiSource[];
};

export type MobilePersistedMultiSource = {
  source: Omit<MobileSourceRecord, "resumeBookmark">;
  sourceBytes: ArrayBuffer;
  games: MobilePersistedGame[];
};

export type MobileLegacySourceRecord = Omit<MobileSourceRecord, "id" | "resumeBookmark">;

export type MobileLegacyLibrarySnapshot = {
  schemaVersion: typeof MOBILE_LEGACY_STORAGE_SCHEMA_VERSION;
  source: MobileLegacySourceRecord;
  sourceBytes: ArrayBuffer;
  games: MobilePersistedGame[];
};

export type MobileStoredSnapshot =
  | MobileLibrarySnapshot
  | MobileMultiSourceLibrarySnapshot
  | MobileLegacyLibrarySnapshot;

export interface MobileLibraryStorage {
  load(): Promise<MobileStoredSnapshot | null>;
  save(snapshot: MobileLibrarySnapshot): Promise<void>;
  clear(): Promise<void>;
}

export class MobileStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MobileStorageError";
  }
}

export type IndexedDbMobileStorageOptions = {
  databaseName?: string;
  databaseFactory?: IDBFactory;
};

export class IndexedDbMobileStorage implements MobileLibraryStorage {
  private readonly databaseName: string;
  private readonly databaseFactory: IDBFactory | undefined;
  private database: Promise<IDBDatabase> | null = null;

  constructor(options: IndexedDbMobileStorageOptions = {}) {
    this.databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
    this.databaseFactory = options.databaseFactory ??
      (typeof indexedDB === "undefined" ? undefined : indexedDB);
  }

  async load(): Promise<MobileStoredSnapshot | null> {
    const database = await this.openDatabase();
    return new Promise<MobileStoredSnapshot | null>((resolve, reject) => {
      let settled = false;
      let value: unknown;
      let transaction: IDBTransaction;

      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(storageError("Could not read the Mobile Library", error));
      };

      try {
        transaction = database.transaction(STORE_NAME, "readonly");
        const request = transaction.objectStore(STORE_NAME).get(ACTIVE_RECORD_KEY);
        request.onsuccess = () => {
          value = request.result;
        };
        request.onerror = () => fail(request.error);
        transaction.oncomplete = () => {
          if (settled) return;
          try {
            const snapshot = value === undefined ? null : parseSnapshot(value);
            settled = true;
            resolve(snapshot);
          } catch (error) {
            fail(error);
          }
        };
        transaction.onerror = () => fail(transaction.error);
        transaction.onabort = () => fail(transaction.error ?? new Error("transaction aborted"));
      } catch (error) {
        fail(error);
      }
    });
  }

  async save(snapshot: MobileLibrarySnapshot): Promise<void> {
    assertSnapshot(snapshot);
    const database = await this.openDatabase();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let transaction: IDBTransaction;

      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(storageError("Could not save the Mobile Library", error));
      };

      try {
        transaction = database.transaction(STORE_NAME, "readwrite");
        const request = transaction.objectStore(STORE_NAME).put(snapshot, ACTIVE_RECORD_KEY);
        request.onerror = () => fail(request.error);
        transaction.oncomplete = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        transaction.onerror = () => fail(transaction.error);
        transaction.onabort = () => fail(transaction.error ?? new Error("transaction aborted"));
      } catch (error) {
        fail(error);
      }
    });
  }

  async clear(): Promise<void> {
    const database = await this.openDatabase();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let transaction: IDBTransaction;

      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(storageError("Could not clear the Mobile Library", error));
      };

      try {
        transaction = database.transaction(STORE_NAME, "readwrite");
        const request = transaction.objectStore(STORE_NAME).delete(ACTIVE_RECORD_KEY);
        request.onerror = () => fail(request.error);
        transaction.oncomplete = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        transaction.onerror = () => fail(transaction.error);
        transaction.onabort = () => fail(transaction.error ?? new Error("transaction aborted"));
      } catch (error) {
        fail(error);
      }
    });
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = this.openDatabaseRequest();
    return this.database;
  }

  private openDatabaseRequest(): Promise<IDBDatabase> {
    if (!this.databaseFactory) {
      return Promise.reject(new MobileStorageError("Browser storage is unavailable."));
    }

    return new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      let upgradeError: unknown;
      try {
        request = this.databaseFactory!.open(
          this.databaseName,
          MOBILE_STORAGE_SCHEMA_VERSION,
        );
      } catch (error) {
        reject(storageError("Could not open the Mobile Library storage", error));
        return;
      }

      request.onupgradeneeded = () => {
        try {
          const database = request.result;
          if (!database.objectStoreNames.contains(STORE_NAME)) {
            database.createObjectStore(STORE_NAME);
          }
        } catch (error) {
          upgradeError = error;
          request.transaction?.abort();
        }
      };
      request.onerror = () => {
        reject(storageError("Could not open the Mobile Library storage", upgradeError ?? request.error));
      };
      request.onblocked = () => {
        reject(new MobileStorageError("Mobile Library storage is blocked by another browser tab."));
      };
      request.onsuccess = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.close();
          reject(new MobileStorageError("Mobile Library storage has an unsupported schema."));
          return;
        }
        database.onversionchange = () => {
          database.close();
          this.database = null;
        };
        resolve(database);
      };
    });
  }
}

function parseSnapshot(value: unknown): MobileStoredSnapshot {
  if (!isSnapshot(value)) {
    throw new MobileStorageError("Mobile Library storage has an unsupported schema.");
  }
  return value;
}

function assertSnapshot(snapshot: MobileLibrarySnapshot): void {
  if (!isCurrentSnapshot(snapshot)) {
    throw new MobileStorageError("Mobile Library snapshot has an unsupported schema.");
  }
}

function isSnapshot(value: unknown): value is MobileStoredSnapshot {
  if (!isRecord(value)) return false;
  if (value.schemaVersion === MOBILE_STORAGE_SCHEMA_VERSION) return isCurrentSnapshot(value);
  if (value.schemaVersion === MOBILE_MULTI_SOURCE_STORAGE_SCHEMA_VERSION) {
    return isMultiSourceSnapshot(value);
  }
  if (value.schemaVersion === MOBILE_LEGACY_STORAGE_SCHEMA_VERSION) return isLegacySnapshot(value);
  return false;
}

function isCurrentSnapshot(value: Record<string, unknown>): value is MobileLibrarySnapshot {
  if (!isSafePositiveIntegerOrNull(value.activeSourceId) || !Array.isArray(value.sources)) return false;
  if (!value.sources.every(isPersistedSource)) return false;
  const sources = value.sources;
  const sourceIds = sources.map((source) => source.source.id);
  if (new Set(sourceIds).size !== sourceIds.length) return false;
  return value.activeSourceId === null || sourceIds.includes(value.activeSourceId);
}

function isMultiSourceSnapshot(value: Record<string, unknown>): value is MobileMultiSourceLibrarySnapshot {
  if (!isSafePositiveIntegerOrNull(value.activeSourceId) || !Array.isArray(value.sources)) return false;
  if (!value.sources.every(isPersistedMultiSource)) return false;
  const sources = value.sources;
  const sourceIds = sources.map((source) => source.source.id);
  if (new Set(sourceIds).size !== sourceIds.length) return false;
  return value.activeSourceId === null || sourceIds.includes(value.activeSourceId);
}

function isLegacySnapshot(value: Record<string, unknown>): value is MobileLegacyLibrarySnapshot {
  if (!isArrayBuffer(value.sourceBytes) || !isLegacySource(value.source)) return false;
  if (value.sourceBytes.byteLength !== value.source.size || !Array.isArray(value.games)) return false;
  return value.games.every((game) => isPersistedGame(game, true));
}

function isPersistedSource(value: unknown): value is MobilePersistedSource {
  if (!isRecord(value) || !isArrayBuffer(value.sourceBytes) || !isSource(value.source)) return false;
  if (value.sourceBytes.byteLength !== value.source.size || !Array.isArray(value.games)) return false;
  return value.games.every((game) => isPersistedGame(game));
}

function isPersistedMultiSource(value: unknown): value is MobilePersistedMultiSource {
  if (!isRecord(value) || !isArrayBuffer(value.sourceBytes) || !isMultiSource(value.source)) return false;
  if (value.sourceBytes.byteLength !== value.source.size || !Array.isArray(value.games)) return false;
  return value.games.every((game) => isPersistedGame(game));
}

function isSource(value: unknown): value is MobileSourceRecord {
  if (!isSourceFields(value)) return false;
  const source = value as MobileSourceRecord;
  return source.resumeBookmark === null || isResumeBookmark(source.resumeBookmark);
}

function isMultiSource(value: unknown): value is Omit<MobileSourceRecord, "resumeBookmark"> {
  return isSourceFields(value);
}

function isSourceFields(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (!isSafePositiveInteger(value.id) || typeof value.name !== "string" || !isSafeNonNegativeInteger(value.size)) return false;
  if (!isSafeNonNegativeInteger(value.game_count) || !isSafeNonNegativeInteger(value.warning_count)) return false;
  if (value.scan_status !== "ready" || value.scan_error !== null) return false;
  if (!isRecord(value.progress)) return false;
  return isSafeNonNegativeInteger(value.progress.bytesDone) &&
    isSafeNonNegativeInteger(value.progress.bytesTotal) &&
    isSafeNonNegativeInteger(value.progress.gamesFound);
}

function isResumeBookmark(value: unknown): value is NonNullable<MobileSourceRecord["resumeBookmark"]> {
  return isRecord(value) &&
    isSafePositiveInteger(value.sourceId) &&
    isSafePositiveInteger(value.gameId);
}

function isLegacySource(value: unknown): value is MobileLegacySourceRecord {
  if (!isRecord(value) || typeof value.name !== "string" || !isSafeNonNegativeInteger(value.size)) return false;
  if (!isSafeNonNegativeInteger(value.game_count) || !isSafeNonNegativeInteger(value.warning_count)) return false;
  if (value.scan_status !== "ready" || value.scan_error !== null) return false;
  if (!isRecord(value.progress)) return false;
  return isSafeNonNegativeInteger(value.progress.bytesDone) &&
    isSafeNonNegativeInteger(value.progress.bytesTotal) &&
    isSafeNonNegativeInteger(value.progress.gamesFound);
}

function isPersistedGame(value: unknown, legacy = false): value is MobilePersistedGame {
  if (!isRecord(value) || !isScannedGame(value.scanned) || !isGameRecord(value.record)) return false;
  return (!legacy || value.record.id === value.scanned.idxInFile + 1) &&
    value.record.idx_in_file === value.scanned.idxInFile &&
    value.record.byte_size === value.scanned.offsetEnd - value.scanned.offsetStart;
}

function isScannedGame(value: unknown): value is ScannedGame {
  if (!isRecord(value)) return false;
  return isSafeNonNegativeInteger(value.idxInFile) &&
    isSafeNonNegativeInteger(value.offsetStart) &&
    isSafeNonNegativeInteger(value.offsetEnd) &&
    value.offsetEnd >= value.offsetStart &&
    Array.isArray(value.headers) &&
    value.headers.every(isTagPair) &&
    (value.warning === null || typeof value.warning === "string");
}

function isGameRecord(value: unknown): value is MobileGameRecord {
  if (!isRecord(value)) return false;
  return isSafeNonNegativeInteger(value.id) && value.id > 0 &&
    isSafeNonNegativeInteger(value.idx_in_file) &&
    typeof value.event === "string" &&
    typeof value.site === "string" &&
    typeof value.date === "string" &&
    typeof value.round === "string" &&
    typeof value.white === "string" &&
    typeof value.black === "string" &&
    typeof value.result === "string" &&
    typeof value.eco === "string" &&
    typeof value.opening === "string" &&
    (value.has_fen === 0 || value.has_fen === 1) &&
    (value.warning === null || typeof value.warning === "string") &&
    isSafeNonNegativeInteger(value.byte_size);
}

function isTagPair(value: unknown): value is [string, string] {
  return Array.isArray(value) && value.length === 2 &&
    typeof value[0] === "string" && typeof value[1] === "string";
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && value > 0;
}

function isSafePositiveIntegerOrNull(value: unknown): value is number | null {
  return value === null || isSafePositiveInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function storageError(prefix: string, error: unknown): MobileStorageError {
  if (error instanceof MobileStorageError) return error;
  const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
  return new MobileStorageError(`${prefix}${detail}`);
}
