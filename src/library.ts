import {
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
} from "node:fs";
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
