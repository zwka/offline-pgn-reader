import { parentPort, workerData } from "node:worker_threads";

import { SqliteIndex } from "./index.js";

export type ScanWorkerData = {
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

export type ScanWorkerMessage = ProgressMessage | CompleteMessage | ErrorMessage;

const scanData = workerData as ScanWorkerData;

function post(message: ScanWorkerMessage): void {
  parentPort?.postMessage(message);
}

async function run(): Promise<void> {
  if (!parentPort) throw new Error("scan worker has no parent port");

  const index = new SqliteIndex(scanData.dbPath);
  await index.replaceGames(
    scanData.fileId,
    scanData.sourcePath,
    (bytesDone, bytesTotal, gamesFound) => {
      post({ type: "progress", bytesDone, bytesTotal, gamesFound });
    },
  );
  post({ type: "complete" });
}

run().catch((error: unknown) => {
  post({ type: "error", error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
