import { statSync } from "node:fs";

import { openSqliteConnection, type SqliteConnection } from "./database.js";
import { fingerprintFile, scanPgn, type ScanProgress, type ScannedGame } from "./scanner.js";

const INSERT_BATCH_SIZE = 500;

export type IndexFileOptions = {
  dbPath: string;
  fileId: number;
  sourcePath: string;
  onProgress?: ScanProgress;
};

export async function indexFile(options: IndexFileOptions): Promise<void> {
  const database = openSqliteConnection(options.dbPath);
  try {
    const startedFingerprint = fingerprintFile(options.sourcePath);
    database.exec("BEGIN");
    try {
      database.prepare("DELETE FROM games WHERE file_id=?").run(options.fileId);

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

      for await (const game of scanPgn(options.sourcePath, options.onProgress)) {
        batch.push(gameRecordValues(options.fileId, game));
        count += 1;
        if (game.warning) warningCount += 1;
        if (batch.length >= INSERT_BATCH_SIZE) {
          insertBatch(insert, batch);
          batch.length = 0;
        }
      }
      if (batch.length > 0) insertBatch(insert, batch);

      const finishedStats = fileStats(options.sourcePath);
      const finishedFingerprint = fingerprintFile(options.sourcePath);
      const verifiedStats = fileStats(options.sourcePath);
      const verifiedFingerprint = fingerprintFile(options.sourcePath);
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
          options.fileId,
        );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
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
