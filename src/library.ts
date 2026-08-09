import {
  createWriteStream,
  linkSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  type Dirent,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

import { IndexBusyError, type Index, type IndexFile, type IndexGame } from "./index.js";
import { hydrateGame, HydrationError } from "./hydration.js";
import {
  readSourceSpan,
  sourceFingerprint,
  sourceStats,
  SourceChangedError,
  SourceMissingError,
  SourceSpanError,
} from "./source.js";
import type { TagPair } from "./scanner.js";
import type {
  DiscoveredSource,
  FileRecord,
  GameDocument,
  GameDocumentPayload,
  GamePage,
} from "./wire.js";
import type { ScanWorkerData, ScanWorkerMessage } from "./scan-worker.js";

const DEFAULT_MAX_GAME_BYTES = 8 * 1024 * 1024;

type FileRow = IndexFile;
type GameDocumentRow = IndexGame;

type ScanProgressState = {
  bytesDone: number;
  bytesTotal: number;
  gamesFound: number;
};

type ActiveScan = {
  worker: ScanWorker;
  progress: ScanProgressState;
  finished: boolean;
  resolve: () => void;
};

type ScanPreparation = {
  file: FileRecord;
  progress: ScanProgressState;
};

type ScanPreparationResult =
  | { kind: "started"; scan: ScanPreparation }
  | { kind: "skipped"; file: FileRecord }
  | { kind: "duplicate"; file: FileRecord };

export type ScanWorker = {
  on(event: "message", listener: (message: ScanWorkerMessage) => void): ScanWorker;
  on(event: "error", listener: (error: Error) => void): ScanWorker;
  on(event: "exit", listener: (code: number) => void): ScanWorker;
  terminate(): Promise<number>;
};

export type ScanWorkerFactory = (data: ScanWorkerData) => ScanWorker;

export type LibraryServiceOptions = {
  workerFactory?: ScanWorkerFactory;
};

export class ServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export class NotFound extends ServiceError {
  constructor(message: string) {
    super(message, 404);
    this.name = "NotFound";
  }
}

export class LibraryService {
  private readonly progress = new Map<number, ScanProgressState>();
  private readonly activeScans = new Map<number, ActiveScan>();

  constructor(
    private readonly index: Index,
    private readonly watchDirs: string[],
    private readonly uploadDir: string,
    private readonly maxGameBytes = DEFAULT_MAX_GAME_BYTES,
    options: LibraryServiceOptions = {},
  ) {
    this.workerFactory = options.workerFactory ?? defaultScanWorker;
    this.index.recoverInterruptedScans();
  }

  private readonly workerFactory: ScanWorkerFactory;

  registerFile(rawPath: string, scan = true): FileRecord {
    const sourcePath = canonicalSourcePath(rawPath);
    const source = this.index.registerFile(sourcePath, basename(sourcePath));
    if (scan) this.startScan(source.id);
    return this.getFile(source.id);
  }

  async uploadFile(
    rawFilename: string,
    source: AsyncIterable<Uint8Array>,
  ): Promise<FileRecord> {
    mkdirSync(this.uploadDir, { recursive: true });
    const filename = normalizeUploadName(rawFilename);
    const temporaryPath = join(this.uploadDir, `.${filename}.${randomUUID()}.tmp`);
    let committedPath: string | undefined;

    try {
      await pipeline(source, createWriteStream(temporaryPath, { flags: "wx" }));
      committedPath = linkUploadPath(this.uploadDir, filename, temporaryPath);
      rmSync(temporaryPath, { force: true });
      return this.registerFile(committedPath);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      if (committedPath) rmSync(committedPath, { force: true });
      throw error;
    }
  }

  listFiles(): FileRecord[] {
    return this.index.listFiles().map((source) => this.toFileRecord(source));
  }

  removeFile(fileId: number): void {
    this.getFile(fileId);
    this.reapFinishedScans(fileId);
    this.assertNoActiveScan(fileId);
    let deleted: boolean;
    try {
      deleted = this.index.deleteFile(fileId);
    } catch (error) {
      throw indexError(error);
    }
    if (!deleted) throw new NotFound(`file ${fileId} not found`);
  }

  resetIndex(): void {
    this.reapFinishedScans();
    this.assertNoActiveScan();
    try {
      this.index.reset();
    } catch (error) {
      throw indexError(error);
    }
    this.progress.clear();
  }

  getFile(fileId: number): FileRecord {
    const source = this.index.getFile(fileId);
    if (!source) throw new NotFound(`file ${fileId} not found`);
    return this.toFileRecord(source);
  }

  listGames(fileId: number, query = "", offset = 0, limit = 100): GamePage {
    this.getFile(fileId);
    return this.index.listGames(fileId, query, offset, limit);
  }

  getGameDocument(gameId: number): Omit<GameDocument, "neighbors"> {
    const row = this.gameRowById(gameId);
    const source = this.readGameBytes(row);
    let hydrated: GameDocumentPayload;
    try {
      const extraWarnings = row.warning ? [`index warning: ${row.warning}`] : [];
      hydrated = hydrateGame(source, this.index.getGameTags(gameId) ?? [], extraWarnings);
    } catch (error) {
      if (error instanceof HydrationError) {
        throw new ServiceError(`game could not be parsed: ${error.message}`, 422);
      }
      throw error;
    }
    return {
      ...hydrated,
      gameId,
      fileId: row.file_id,
      fileName: row.file_name,
      idxInFile: row.idx_in_file,
    };
  }

  getGameSource(gameId: number): string {
    const row = this.gameRowById(gameId);
    return this.readGameBytes(row).toString("utf8");
  }

  getGameTags(gameId: number): TagPair[] {
    this.gameRowById(gameId);
    return this.index.getGameTags(gameId) ?? [];
  }

  neighborGameIds(gameId: number): { prev: number | null; next: number | null } {
    const neighbors = this.index.neighborGameIds(gameId);
    if (!neighbors) throw new NotFound(`game ${gameId} not found`);
    return neighbors;
  }

  async scanFileSync(fileId: number, force = false): Promise<FileRecord> {
    const result = this.prepareScan(fileId, force);
    if (result.kind === "skipped") return result.file;
    if (result.kind === "duplicate") {
      throw new ServiceError("scan already in progress", 409);
    }

    await this.launchScan(result.scan);
    return this.getFile(fileId);
  }

  startScan(fileId: number, force = false): boolean {
    const result = this.prepareScan(fileId, force);
    if (result.kind !== "started") return false;
    void this.launchScan(result.scan);
    return true;
  }

  async close(): Promise<void> {
    const scans = [...this.activeScans.values()];
    for (const scan of scans) scan.finished = true;
    this.activeScans.clear();
    this.progress.clear();
    await Promise.allSettled(scans.map((scan) => scan.worker.terminate()));
    this.index.recoverInterruptedScans();
    for (const scan of scans) scan.resolve();
  }

  discover(): DiscoveredSource[] {
    const registered = new Set(this.index.sourcePaths());
    const seen = new Set<string>();
    const discovered: DiscoveredSource[] = [];

    for (const directory of this.watchDirs) {
      for (const candidate of pgnFiles(directory)) {
        let sourcePath: string;
        try {
          sourcePath = realpathSync(candidate);
        } catch {
          continue;
        }
        if (seen.has(sourcePath)) continue;
        seen.add(sourcePath);

        let size: number;
        try {
          const stats = statSync(sourcePath);
          if (!stats.isFile()) continue;
          size = stats.size;
        } catch {
          continue;
        }
        discovered.push({
          path: sourcePath,
          name: basename(sourcePath),
          size,
          registered: registered.has(sourcePath),
        });
      }
    }
    return discovered;
  }

  private prepareScan(fileId: number, force: boolean): ScanPreparationResult {
    this.reapFinishedScans(fileId);
    const file = this.getFile(fileId);
    if (this.activeScans.has(fileId) || file.scan_status === "scanning") {
      return { kind: "duplicate", file };
    }

    if (!force && file.scan_status === "ready") {
      try {
        if (sourceFingerprint(file.path) === file.fingerprint) {
          return { kind: "skipped", file };
        }
      } catch {
        throw new ServiceError(`source file missing: ${file.path}`, 409);
      }
    }

    let bytesTotal: number;
    try {
      bytesTotal = sourceStats(file.path).size;
    } catch {
      throw new ServiceError(`source file missing: ${file.path}`, 409);
    }

    if (!this.index.claimScan(fileId)) {
      return { kind: "duplicate", file };
    }

    const progress: ScanProgressState = { bytesDone: 0, bytesTotal, gamesFound: 0 };
    this.progress.set(fileId, progress);
    return { kind: "started", scan: { file, progress } };
  }

  private launchScan(scan: ScanPreparation): Promise<void> {
    let worker: ScanWorker;
    try {
      worker = this.workerFactory({
        dbPath: this.index.path,
        fileId: scan.file.id,
        sourcePath: scan.file.path,
      });
    } catch (error) {
      this.progress.delete(scan.file.id);
      this.setScanError(scan.file.id, error);
      throw error;
    }

    return new Promise<void>((resolve) => {
      const state: ActiveScan = {
        worker,
        progress: scan.progress,
        finished: false,
        resolve,
      };
      this.activeScans.set(scan.file.id, state);

      const finish = (error?: unknown): void => {
        if (state.finished) return;
        state.finished = true;
        const isCurrent = this.activeScans.get(scan.file.id) === state;
        if (isCurrent) {
          this.activeScans.delete(scan.file.id);
          this.progress.delete(scan.file.id);
          if (error !== undefined) this.setScanError(scan.file.id, error);
        }
        state.resolve();
      };

      try {
        worker.on("message", (message) => {
          if (state.finished) return;
          if (message.type === "progress") {
            state.progress.bytesDone = message.bytesDone;
            state.progress.bytesTotal = message.bytesTotal;
            state.progress.gamesFound = message.gamesFound;
          } else if (message.type === "complete") {
            finish();
          } else {
            finish(message.error);
          }
        });
        worker.on("error", (error) => finish(error));
        worker.on("exit", (code) => {
          if (code !== 0) finish(new Error(`scan worker exited with code ${code}`));
          else if (!state.finished) finish(new Error("scan worker exited before completion"));
        });
      } catch (error) {
        finish(error);
      }
    });
  }

  private reapFinishedScans(fileId?: number): void {
    const scans = fileId === undefined
      ? [...this.activeScans.entries()]
      : [[fileId, this.activeScans.get(fileId)] as const];
    for (const [id, scan] of scans) {
      if (!scan) continue;
      const file = this.index.getFile(id);
      if (file && file.scan_status === "scanning") continue;
      this.retireScan(id, scan);
    }
  }

  private retireScan(fileId: number, scan: ActiveScan): void {
    scan.finished = true;
    if (this.activeScans.get(fileId) === scan) {
      this.activeScans.delete(fileId);
      this.progress.delete(fileId);
    }
    scan.resolve();
    try {
      void scan.worker.terminate().catch(() => undefined);
    } catch {
      // The worker has already exited; its state is retired either way.
    }
  }

  private assertNoActiveScan(fileId?: number): void {
    if (!this.index.hasActiveScan(fileId)) return;
    throw new ServiceError(
      fileId === undefined
        ? "cannot reset while a scan is running"
        : "cannot remove file while a scan is running",
      409,
    );
  }

  private toFileRecord(source: FileRow): FileRecord {
    let exists = false;
    let stale = false;
    try {
      sourceStats(source.path);
      exists = true;
      if (source.fingerprint) {
        stale = sourceFingerprint(source.path) !== source.fingerprint;
      }
    } catch {
      // A registered source can disappear after registration; keep its record readable.
    }
    return {
      id: source.id,
      path: source.path,
      name: source.name,
      size: source.size,
      mtime_ns: source.mtime_ns,
      fingerprint: source.fingerprint,
      game_count: source.game_count,
      warning_count: source.warning_count,
      scan_status: source.scan_status,
      scan_error: source.scan_error,
      scanned_at: source.scanned_at,
      exists,
      stale,
      progress: source.scan_status === "scanning"
        ? this.progress.get(source.id) ?? null
        : null,
    };
  }

  private gameRowById(gameId: number): GameDocumentRow {
    const row = this.index.getGame(gameId);
    if (!row) throw new NotFound(`game ${gameId} not found`);
    return row;
  }

  private readGameBytes(row: GameDocumentRow): Buffer {
    if (row.file_scan_status !== "ready") {
      throw new ServiceError(
        `source index is not ready for reads: ${row.file_scan_status}`,
        409,
      );
    }
    try {
      return readSourceSpan(
        row.file_path,
        row.offset_start,
        row.offset_end,
        this.maxGameBytes,
        row.file_fingerprint,
      );
    } catch (error) {
      if (error instanceof SourceMissingError || error instanceof SourceChangedError) {
        throw new ServiceError(error.message, 409);
      }
      if (error instanceof SourceSpanError) throw new ServiceError(error.message, 422);
      throw error;
    }
  }

  private setScanError(fileId: number, error: unknown): void {
    this.index.markScanError(fileId, error);
  }
}

function indexError(error: unknown): unknown {
  return error instanceof IndexBusyError
    ? new ServiceError(error.message, 409)
    : error;
}

function defaultScanWorker(data: ScanWorkerData): ScanWorker {
  return new Worker(new URL("./scan-worker.ts", import.meta.url), {
    workerData: data,
    execArgv: workerExecArgv(),
  }) as unknown as ScanWorker;
}

function canonicalSourcePath(rawPath: string): string {
  const expanded = rawPath === "~"
    ? homedir()
    : rawPath.startsWith("~/")
      ? join(homedir(), rawPath.slice(2))
      : rawPath;
  const candidate = isAbsolute(expanded) ? expanded : resolve(expanded);
  let sourcePath: string;
  try {
    sourcePath = realpathSync(candidate);
  } catch {
    throw new ServiceError(`not a file: ${candidate}`, 404);
  }
  let stats;
  try {
    stats = statSync(sourcePath);
  } catch {
    throw new ServiceError(`not a file: ${sourcePath}`, 404);
  }
  if (!stats.isFile()) throw new ServiceError(`not a file: ${sourcePath}`, 404);
  if (extname(sourcePath).toLowerCase() !== ".pgn") {
    throw new ServiceError(`not a .pgn file: ${basename(sourcePath)}`, 422);
  }
  return sourcePath;
}

function normalizeUploadName(rawFilename: string): string {
  const filename = basename(rawFilename.replaceAll("\\", "/"));
  const sanitizedFilename = filename
    .replace(/[^\p{L}\p{N}_\s.\-()]/gu, "_")
    .trim();
  const normalized = sanitizedFilename && sanitizedFilename !== "." && sanitizedFilename !== ".."
    ? sanitizedFilename
    : "upload.pgn";
  return normalized.toLowerCase().endsWith(".pgn") ? normalized : `${normalized}.pgn`;
}

function linkUploadPath(directory: string, filename: string, sourcePath: string): string {
  const extension = extname(filename);
  const stem = filename.slice(0, -extension.length);
  let candidate = join(directory, filename);
  let suffix = 1;
  while (true) {
    try {
      linkSync(sourcePath, candidate);
      return candidate;
    } catch (error) {
      if (!isExistingPathError(error)) throw error;
      candidate = join(directory, `${stem}-${suffix}${extension}`);
      suffix += 1;
    }
  }
}

function isExistingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function pgnFiles(directory: string): string[] {
  const candidates: string[] = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".pgn") {
        candidates.push(candidate);
      }
    }
  }
  return candidates.sort();
}

function workerExecArgv(): string[] {
  const hasTsxLoader = process.execArgv.some(
    (argument, index) => argument === "tsx/esm" ||
      (argument === "--import" && process.execArgv[index + 1] === "tsx/esm"),
  );
  return hasTsxLoader ? process.execArgv : [...process.execArgv, "--import", "tsx/esm"];
}
