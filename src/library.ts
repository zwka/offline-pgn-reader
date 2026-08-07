import {
  createWriteStream,
  closeSync,
  openSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  type Dirent,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

import { LibraryDatabase } from "./database.js";
import type { DiscoveredSource, FileRecord } from "./wire.js";

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
  constructor(
    private readonly database: LibraryDatabase,
    private readonly watchDirs: string[],
    private readonly uploadDir: string,
  ) {
    this.database.initialize();
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
    return this.toFileRecord(source);
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
      committedPath = reserveUploadPath(this.uploadDir, filename);
      renameSync(temporaryPath, committedPath);
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
      const stats = statSync(source.path);
      exists = stats.isFile();
      stale = exists && source.scan_status === "ready" && (
        stats.size !== source.size || fileMtimeNs(stats.mtimeMs) !== source.mtime_ns
      );
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
      progress: null,
    };
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
  const safe = filename
    .replace(/[^\p{L}\p{N}_\s.\-()]/gu, "_")
    .trim();
  const normalized = safe && safe !== "." && safe !== ".." ? safe : "upload.pgn";
  return normalized.toLowerCase().endsWith(".pgn") ? normalized : `${normalized}.pgn`;
}

function reserveUploadPath(directory: string, filename: string): string {
  const extension = extname(filename);
  const stem = filename.slice(0, -extension.length);
  let candidate = join(directory, filename);
  let suffix = 1;
  while (true) {
    try {
      const descriptor = openSync(candidate, "wx", 0o600);
      closeSync(descriptor);
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

function fileMtimeNs(mtimeMs: number): number {
  return Math.trunc(mtimeMs * 1_000_000);
}
