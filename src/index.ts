import { statSync } from "node:fs";

import {
  openSqliteConnection,
  LibraryDatabase,
  type SqliteConnection,
} from "./database.js";
import {
  fingerprintFile,
  scanPgn,
  type ScanProgress,
  type ScannedGame,
  type TagPair,
} from "./scanner.js";
import type { GamePage } from "./wire.js";

const INSERT_BATCH_SIZE = 500;

export type ScanStatus = "pending" | "scanning" | "ready" | "error";

export type IndexFile = {
  id: number;
  path: string;
  name: string;
  size: number;
  mtime_ns: number;
  fingerprint: string;
  game_count: number;
  warning_count: number;
  scan_status: ScanStatus;
  scan_error: string | null;
  scanned_at: string | null;
};

export type IndexGame = {
  id: number;
  file_id: number;
  idx_in_file: number;
  offset_start: number;
  offset_end: number;
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
  tag_json: string;
  warning: string | null;
  file_path: string;
  file_name: string;
  file_scan_status: ScanStatus;
  file_fingerprint: string;
};

export type NeighborGameIds = { prev: number | null; next: number | null };

export interface Index {
  readonly path: string;

  recoverInterruptedScans(): void;
  registerFile(path: string, name: string): IndexFile;
  listFiles(): IndexFile[];
  getFile(fileId: number): IndexFile | undefined;
  deleteFile(fileId: number): boolean;
  reset(): void;
  sourcePaths(): string[];

  hasActiveScan(fileId?: number): boolean;
  claimScan(fileId: number): boolean;
  markScanError(fileId: number, error: unknown): void;
  replaceGames(fileId: number, sourcePath: string, onProgress?: ScanProgress): Promise<void>;

  listGames(fileId: number, query?: string, offset?: number, limit?: number): GamePage;
  getGame(gameId: number): IndexGame | undefined;
  getGameTags(gameId: number): TagPair[] | undefined;
  neighborGameIds(gameId: number): NeighborGameIds | undefined;
}

export class IndexBusyError extends Error {
  constructor(operation: "remove" | "reset") {
    super(
      operation === "reset"
        ? "cannot reset while a scan is running"
        : "cannot remove file while a scan is running",
    );
    this.name = "IndexBusyError";
  }
}

export class SqliteIndex implements Index {
  private readonly database: LibraryDatabase;

  constructor(path: string) {
    this.database = new LibraryDatabase(path);
    this.database.initialize();
  }

  get path(): string {
    return this.database.path;
  }

  recoverInterruptedScans(): void {
    this.database.withConnection((database) => {
      database
        .prepare(
          "UPDATE files SET scan_status='pending', scan_error=NULL WHERE scan_status='scanning'",
        )
        .run();
    });
  }

  registerFile(path: string, name: string): IndexFile {
    return this.database.withConnection((database) => {
      database
        .prepare("INSERT OR IGNORE INTO files(path, name) VALUES (?, ?)")
        .run(path, name);
      const file = database
        .prepare("SELECT * FROM files WHERE path=?")
        .get(path) as IndexFile | undefined;
      if (!file) throw new Error(`could not register source: ${path}`);
      return file;
    });
  }

  listFiles(): IndexFile[] {
    return this.database.withConnection((database) =>
      database
        .prepare("SELECT * FROM files ORDER BY name")
        .all() as IndexFile[],
    );
  }

  getFile(fileId: number): IndexFile | undefined {
    return this.database.withConnection((database) =>
      database
        .prepare("SELECT * FROM files WHERE id=?")
        .get(fileId) as IndexFile | undefined,
    );
  }

  deleteFile(fileId: number): boolean {
    if (this.hasActiveScan(fileId)) throw new IndexBusyError("remove");
    const deleted = this.database.withConnection((database) =>
      database.prepare("DELETE FROM files WHERE id=?").run(fileId),
    );
    return deleted.changes === 1;
  }

  reset(): void {
    if (this.hasActiveScan()) throw new IndexBusyError("reset");
    this.database.reset();
  }

  sourcePaths(): string[] {
    return this.database.withConnection((database) =>
      (database.prepare("SELECT path FROM files").all() as { path: string }[])
        .map((row) => row.path),
    );
  }

  hasActiveScan(fileId?: number): boolean {
    return this.database.withConnection((database) => {
      const row = fileId === undefined
        ? database
            .prepare("SELECT 1 AS active FROM files WHERE scan_status='scanning' LIMIT 1")
            .get() as { active: number } | undefined
        : database
            .prepare("SELECT 1 AS active FROM files WHERE id=? AND scan_status='scanning'")
            .get(fileId) as { active: number } | undefined;
      return row !== undefined;
    });
  }

  claimScan(fileId: number): boolean {
    return this.database.withConnection((database) => {
      const result = database
        .prepare(
          "UPDATE files SET scan_status='scanning', scan_error=NULL " +
            "WHERE id=? AND scan_status!='scanning'",
        )
        .run(fileId);
      return result.changes === 1;
    });
  }

  markScanError(fileId: number, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.database.withConnection((database) => {
      database
        .prepare("UPDATE files SET scan_status='error', scan_error=? WHERE id=?")
        .run(message, fileId);
    });
  }

  async replaceGames(
    fileId: number,
    sourcePath: string,
    onProgress?: ScanProgress,
  ): Promise<void> {
    let failed = false;
    let failure: unknown;
    const database = openSqliteConnection(this.path);
    let transactionOpen = false;

    try {
      const startedFingerprint = fingerprintFile(sourcePath);
      database.exec("BEGIN");
      transactionOpen = true;
      database.prepare("DELETE FROM games WHERE file_id=?").run(fileId);

      const insert = database.prepare(
        `INSERT INTO games(
           file_id, idx_in_file, offset_start, offset_end,
           event, site, date, round, white, black, result, eco, opening,
           has_fen, tag_json, warning
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      const batch: unknown[][] = [];
      let count = 0;
      let warningCount = 0;

      for await (const game of scanPgn(sourcePath, onProgress)) {
        batch.push(gameRecordValues(fileId, game));
        count += 1;
        if (game.warning) warningCount += 1;
        if (batch.length >= INSERT_BATCH_SIZE) {
          insertBatch(insert, batch);
          batch.length = 0;
        }
      }
      if (batch.length > 0) insertBatch(insert, batch);

      const finishedStats = fileStats(sourcePath);
      const finishedFingerprint = fingerprintFile(sourcePath);
      const verifiedStats = fileStats(sourcePath);
      const verifiedFingerprint = fingerprintFile(sourcePath);
      if (
        startedFingerprint !== finishedFingerprint ||
        finishedFingerprint !== verifiedFingerprint ||
        finishedStats.size !== verifiedStats.size ||
        finishedStats.mtimeNs !== verifiedStats.mtimeNs
      ) {
        throw new Error("source changed during scan");
      }
      database
        .prepare(
          `UPDATE files SET size=?, mtime_ns=?, fingerprint=?, game_count=?,
             warning_count=?, scan_status='ready', scan_error=NULL,
             scanned_at=datetime('now') WHERE id=?`,
        )
        .run(
          verifiedStats.size,
          verifiedStats.mtimeNs,
          verifiedFingerprint,
          count,
          warningCount,
          fileId,
        );
      database.exec("COMMIT");
      transactionOpen = false;
    } catch (error) {
      failed = true;
      failure = error;
      if (transactionOpen) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Preserve the original scan failure; the connection is closing.
        }
      }
    } finally {
      database.close();
    }

    if (failed) {
      this.markScanError(fileId, failure);
      throw failure;
    }
  }

  listGames(fileId: number, query = "", offset = 0, limit = 100): GamePage {
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
        .all(...params, normalizedLimit, normalizedOffset) as GamePage["games"];
      return {
        total,
        offset: normalizedOffset,
        limit: normalizedLimit,
        games,
      };
    });
  }

  getGame(gameId: number): IndexGame | undefined {
    return this.database.withConnection((database) =>
      database
        .prepare(
          `SELECT g.*, f.path AS file_path, f.name AS file_name,
             f.scan_status AS file_scan_status, f.fingerprint AS file_fingerprint
           FROM games g JOIN files f ON f.id = g.file_id WHERE g.id=?`,
        )
        .get(gameId) as IndexGame | undefined,
    );
  }

  getGameTags(gameId: number): TagPair[] | undefined {
    const game = this.getGame(gameId);
    if (!game) return undefined;
    return storedHeaders(game.tag_json) ?? [];
  }

  neighborGameIds(gameId: number): NeighborGameIds | undefined {
    const game = this.getGame(gameId);
    if (!game) return undefined;
    return this.database.withConnection((database) => {
      const prev = database
        .prepare(
          "SELECT id FROM games WHERE file_id=? AND idx_in_file<? ORDER BY idx_in_file DESC LIMIT 1",
        )
        .get(game.file_id, game.idx_in_file) as { id: number } | undefined;
      const next = database
        .prepare(
          "SELECT id FROM games WHERE file_id=? AND idx_in_file>? ORDER BY idx_in_file LIMIT 1",
        )
        .get(game.file_id, game.idx_in_file) as { id: number } | undefined;
      return { prev: prev?.id ?? null, next: next?.id ?? null };
    });
  }
}

function gameRecordValues(fileId: number, game: ScannedGame): unknown[] {
  const tags = new Map(game.headers);
  return [
    fileId,
    game.idxInFile,
    game.offsetStart,
    game.offsetEnd,
    tags.get("Event") ?? "",
    tags.get("Site") ?? "",
    tags.get("Date") ?? "",
    tags.get("Round") ?? "",
    tags.get("White") ?? "",
    tags.get("Black") ?? "",
    tags.get("Result") ?? "",
    tags.get("ECO") ?? "",
    tags.get("Opening") ?? "",
    tags.has("FEN") ? 1 : 0,
    JSON.stringify(game.headers),
    game.warning,
  ];
}

function insertBatch(
  insert: ReturnType<SqliteConnection["prepare"]>,
  rows: unknown[][],
): void {
  for (const row of rows) insert.run(row);
}

function fileStats(path: string): { size: bigint; mtimeNs: bigint } {
  const stats = statSync(path, { bigint: true });
  return { size: stats.size, mtimeNs: stats.mtimeNs };
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
