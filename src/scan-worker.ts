import { parentPort, workerData } from "node:worker_threads";

import { indexFile } from "./indexer.js";

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

  await indexFile({
    dbPath: scanData.dbPath,
    fileId: scanData.fileId,
    sourcePath: scanData.sourcePath,
    onProgress: (bytesDone, bytesTotal, gamesFound) => {
      post({ type: "progress", bytesDone, bytesTotal, gamesFound });
    },
  });
  post({ type: "complete" });
}

run().catch((error: unknown) => {
  post({ type: "error", error: error instanceof Error ? error.message : String(error) });
});
