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

import { LibraryDatabase } from "./database.js";
import { fingerprintFile, readGameBytes as readGameSpan, type TagPair } from "./scanner.js";
import { hydrateGame, HydrationError } from "./hydration.js";
import type {
  DiscoveredSource,
  FileRecord,
  GameDocument,
  GameDocumentPayload,
  GamePage,
} from "./wire.js";

const MAX_GAME_BYTES = 8 * 1024 * 1024;

type FileRow = {
  id: number;
  path: string;
  name: string;
  size: number;
  mtime_ns: number;
  fingerprint: string;
  game_count: number;
  warning_count: number;
  scan_status: "pending" | "scanning" | "ready" | "error";
  scan_error: string | null;
  scanned_at: string | null;
};

type GameRecordRow = {
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

type GameDocumentRow = GameRecordRow & {
  file_id: number;
  offset_start: number;
  offset_end: number;
  tag_json: string;
  file_path: string;
  file_name: string;
  file_scan_status: "pending" | "scanning" | "ready" | "error";
  file_fingerprint: string;
};

type ScanProgressState = {
  bytesDone: number;
  bytesTotal: number;
  gamesFound: number;
};

type ActiveScan = {
  worker: Worker;
  progress: ScanProgressState;
  finished: boolean;
};

type ScanWorkerMessage =
  | { type: "progress"; bytesDone: number; bytesTotal: number; gamesFound: number }
  | { type: "complete" }
  | { type: "error"; error: string };

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
    private readonly database: LibraryDatabase,
    private readonly watchDirs: string[],
    private readonly uploadDir: string,
  ) {
    this.database.initialize();
    this.recoverInterruptedScans();
  }

  private recoverInterruptedScans(): void {
    this.database.withConnection((database) => {
      database
        .prepare(
          "UPDATE files SET scan_status='pending', scan_error=NULL WHERE scan_status='scanning'",
        )
        .run();
    });
  }

  registerFile(rawPath: string): FileRecord {
    const sourcePath = canonicalSourcePath(rawPath);
    const source = this.database.withConnection((database) => {
      database
        .prepare("INSERT OR IGNORE INTO files(path, name) VALUES (?, ?)")
        .run(sourcePath, basename(sourcePath));
      return database
        .prepare("SELECT * FROM files WHERE path=?")
        .get(sourcePath) as FileRow;
    });
    this.startScan(source.id);
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
    const sources = this.database.withConnection((database) =>
      database
        .prepare("SELECT * FROM files ORDER BY name")
        .all() as FileRow[],
    );
    return sources.map((source) => this.toFileRecord(source));
  }

  getFile(fileId: number): FileRecord {
    const source = this.database.withConnection((database) =>
      database
        .prepare("SELECT * FROM files WHERE id=?")
        .get(fileId) as FileRow | undefined,
    );
    if (!source) throw new NotFound(`file ${fileId} not found`);
    return this.toFileRecord(source);
  }

  listGames(fileId: number, query = "", offset = 0, limit = 100): GamePage {
    this.getFile(fileId);
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = Math.max(1, Math.min(limit, 500));
    const search = query.trim();
    const where = ["file_id=?"];
    const params: Array<string | number> = [fileId];
    if (search) {
      const like = `%${search}%`;
      where.push(
        "(white LIKE ? OR black LIKE ? OR event LIKE ? OR site LIKE ? OR opening LIKE ? OR eco LIKE ? OR date LIKE ?)",
      );
      params.push(like, like, like, like, like, like, like);
    }
    const whereSql = where.join(" AND ");
    return this.database.withConnection((database) => {
      const total = (database
        .prepare(`SELECT COUNT(*) AS count FROM games WHERE ${whereSql}`)
        .get(...params) as { count: number }).count;
      const games = database
        .prepare(
          `SELECT id, idx_in_file, event, site, date, round, white, black,
             result, eco, opening, has_fen, warning,
             offset_end - offset_start AS byte_size
           FROM games WHERE ${whereSql}
           ORDER BY idx_in_file LIMIT ? OFFSET ?`,
        )
        .all(...params, normalizedLimit, normalizedOffset) as GameRecordRow[];
      return {
        total,
        offset: normalizedOffset,
        limit: normalizedLimit,
        games,
      };
    });
  }

  getGameDocument(gameId: number): Omit<GameDocument, "neighbors"> {
    const row = this.gameRowById(gameId);
    const source = this.readGameBytes(row);
    let hydrated: GameDocumentPayload;
    try {
      hydrated = hydrateGame(source, storedHeaders(row.tag_json));
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

  neighborGameIds(gameId: number): { prev: number | null; next: number | null } {
    const row = this.gameRowById(gameId);
    return this.database.withConnection((database) => {
      const prev = database
        .prepare(
          "SELECT id FROM games WHERE file_id=? AND idx_in_file<? ORDER BY idx_in_file DESC LIMIT 1",
        )
        .get(row.file_id, row.idx_in_file) as { id: number } | undefined;
      const next = database
        .prepare(
          "SELECT id FROM games WHERE file_id=? AND idx_in_file>? ORDER BY idx_in_file LIMIT 1",
        )
        .get(row.file_id, row.idx_in_file) as { id: number } | undefined;
      return { prev: prev?.id ?? null, next: next?.id ?? null };
    });
  }

  startScan(fileId: number, force = false): boolean {
    const file = this.getFile(fileId);
    if (this.activeScans.has(fileId)) return false;
    if (file.scan_status === "scanning") return false;

    if (!force && file.scan_status === "ready") {
      try {
        if (fingerprintFile(file.path) === file.fingerprint) return false;
      } catch {
        throw new ServiceError(`source file missing: ${file.path}`, 409);
      }
    }

    let bytesTotal: number;
    try {
      bytesTotal = statSync(file.path).size;
    } catch {
      throw new ServiceError(`source file missing: ${file.path}`, 409);
    }

    const progress: ScanProgressState = { bytesDone: 0, bytesTotal, gamesFound: 0 };
    const claimed = this.database.withConnection((database) => {
      const result = database
        .prepare(
          "UPDATE files SET scan_status='scanning', scan_error=NULL " +
            "WHERE id=? AND scan_status!='scanning'",
        )
        .run(fileId);
      return result.changes === 1;
    });
    if (!claimed) return false;
    this.progress.set(fileId, progress);

    let worker: Worker;
    try {
      worker = new Worker(new URL("./scan-worker.ts", import.meta.url), {
        workerData: {
          dbPath: this.database.path,
          fileId,
          sourcePath: file.path,
        },
        execArgv: workerExecArgv(),
      });
    } catch (error) {
      this.progress.delete(fileId);
      this.setScanError(fileId, error);
      throw error;
    }

    const state: ActiveScan = { worker, progress, finished: false };
    this.activeScans.set(fileId, state);
    const finish = (error?: unknown) => {
      if (state.finished) return;
      state.finished = true;
      this.activeScans.delete(fileId);
      this.progress.delete(fileId);
      if (error) this.setScanError(fileId, error);
    };
    worker.on("message", (message: ScanWorkerMessage) => {
      if (state.finished) return;
      if (message.type === "progress") {
        state.progress.bytesDone = message.bytesDone;
        state.progress.bytesTotal = message.bytesTotal;
        state.progress.gamesFound = message.gamesFound;
      } else if (message.type === "complete") {
        finish();
      } else if (message.type === "error") {
        finish(message.error);
      }
    });
    worker.on("error", (error) => finish(error));
    worker.on("exit", (code) => {
      if (code !== 0) finish(new Error(`scan worker exited with code ${code}`));
    });
    return true;
  }

  async close(): Promise<void> {
    const scans = [...this.activeScans.values()];
    for (const scan of scans) scan.finished = true;
    this.activeScans.clear();
    this.progress.clear();
    await Promise.allSettled(scans.map((scan) => scan.worker.terminate()));
  }

  discover(): DiscoveredSource[] {
    const registered = this.database.withConnection((database) =>
      new Set(
        (database.prepare("SELECT path FROM files").all() as { path: string }[])
          .map((row) => row.path),
      ),
    );
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

  private toFileRecord(source: FileRow): FileRecord {
    let exists = false;
    let stale = false;
    try {
      const stats = statSync(source.path, { bigint: true });
      exists = stats.isFile();
      if (exists && source.scan_status === "ready") {
        stale = Number(stats.size) !== source.size ||
          fileMtimeNs(stats.mtimeNs) !== source.mtime_ns;
        if (!stale) {
          try {
            stale = fingerprintFile(source.path) !== source.fingerprint;
          } catch {
            stale = true;
          }
        }
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
    const row = this.database.withConnection((database) =>
      database
        .prepare(
          `SELECT g.*, f.path AS file_path, f.name AS file_name,
             f.scan_status AS file_scan_status, f.fingerprint AS file_fingerprint
           FROM games g JOIN files f ON f.id = g.file_id WHERE g.id=?`,
        )
        .get(gameId) as GameDocumentRow | undefined,
    );
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
      if (!statSync(row.file_path).isFile()) throw new Error("not a file");
      if (fingerprintFile(row.file_path) !== row.file_fingerprint) {
        throw new ServiceError(`source changed since scan: ${row.file_path}`, 409);
      }
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(`source file missing: ${row.file_path}`, 409);
    }

    const data = readGameSpan(
      row.file_path,
      row.offset_start,
      row.offset_end,
      MAX_GAME_BYTES,
    );
    try {
      if (fingerprintFile(row.file_path) !== row.file_fingerprint) {
        throw new ServiceError(`source changed since scan: ${row.file_path}`, 409);
      }
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(`source file missing: ${row.file_path}`, 409);
    }
    return data;
  }

  private setScanError(fileId: number, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.database.withConnection((database) => {
      database
        .prepare("UPDATE files SET scan_status='error', scan_error=? WHERE id=?")
        .run(message, fileId);
    });
  }
}

function storedHeaders(raw: string): TagPair[] | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const headers = parsed.filter(
      (pair): pair is [string, string] =>
        Array.isArray(pair) && pair.length === 2 &&
        typeof pair[0] === "string" && typeof pair[1] === "string",
    );
    return headers.length === parsed.length ? headers : undefined;
  } catch {
    return undefined;
  }
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

function fileMtimeNs(mtimeNs: bigint): number {
  return Number(mtimeNs);
}

function workerExecArgv(): string[] {
  const hasTsxLoader = process.execArgv.some(
    (argument, index) => argument === "tsx/esm" ||
      (argument === "--import" && process.execArgv[index + 1] === "tsx/esm"),
  );
  return hasTsxLoader ? process.execArgv : [...process.execArgv, "--import", "tsx/esm"];
}
