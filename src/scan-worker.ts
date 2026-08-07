import { statSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

import { openSqliteConnection, type SqliteConnection } from "./database.js";
import { fingerprintFile, scanPgn, type ScannedGame } from "./scanner.js";

const INSERT_BATCH_SIZE = 500;

type ScanWorkerData = {
  dbPath: string;
  fileId: number;
  sourcePath: string;
};

type ProgressMessage = {
  type: "progress";
  bytesDone: number;
  bytesTotal: number;
  gamesFound: number;
};

type CompleteMessage = {
  type: "complete";
};

type ErrorMessage = {
  type: "error";
  error: string;
};

type ScanWorkerMessage = ProgressMessage | CompleteMessage | ErrorMessage;

const scanData = workerData as ScanWorkerData;

function post(message: ScanWorkerMessage): void {
  parentPort?.postMessage(message);
}

async function run(): Promise<void> {
  if (!parentPort) throw new Error("scan worker has no parent port");

  const database = openSqliteConnection(scanData.dbPath);
  try {
    const startedFingerprint = fingerprintFile(scanData.sourcePath);
    database.exec("BEGIN");
    try {
      database.prepare("DELETE FROM games WHERE file_id=?").run(scanData.fileId);

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

      for await (const game of scanPgn(scanData.sourcePath, (bytesDone, bytesTotal, gamesFound) => {
        post({ type: "progress", bytesDone, bytesTotal, gamesFound });
      })) {
        batch.push(gameRecordValues(scanData.fileId, game));
        count += 1;
        if (game.warning) warningCount += 1;
        if (batch.length >= INSERT_BATCH_SIZE) {
          insertBatch(insert, batch);
          batch.length = 0;
        }
      }
      if (batch.length > 0) insertBatch(insert, batch);

      const finishedStats = fileStats(scanData.sourcePath);
      const finishedFingerprint = fingerprintFile(scanData.sourcePath);
      const verifiedStats = fileStats(scanData.sourcePath);
      const verifiedFingerprint = fingerprintFile(scanData.sourcePath);
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
          scanData.fileId,
        );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    post({ type: "complete" });
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

function insertBatch(insert: ReturnType<SqliteConnection["prepare"]>, rows: unknown[][]): void {
  for (const row of rows) insert.run(row);
}

function fileStats(path: string): { size: bigint; mtimeNs: bigint } {
  const stats = statSync(path, { bigint: true });
  return { size: stats.size, mtimeNs: stats.mtimeNs };
}

run().catch((error: unknown) => {
  post({ type: "error", error: error instanceof Error ? error.message : String(error) });
});
