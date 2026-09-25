import { BlobSource } from "../browser-source.js";
import { scanPgn } from "../scan.js";
import type { MobileScanMessage, MobileScanRequest } from "./scan-protocol.js";

type MobileWorkerScope = {
  onmessage: ((event: MessageEvent<MobileScanRequest>) => void) | null;
  postMessage(message: MobileScanMessage): void;
};

const worker = globalThis as unknown as MobileWorkerScope;

worker.onmessage = (event) => {
  if (event.data.type !== "scan") return;
  void scanSource(event.data.source);
};

async function scanSource(blob: Blob): Promise<void> {
  const source = new BlobSource(blob);
  worker.postMessage({
    type: "progress",
    bytesDone: 0,
    bytesTotal: source.size,
    gamesFound: 0,
  });

  try {
    for await (const game of scanPgn(
      source,
      (bytesDone, bytesTotal, gamesFound) => {
        worker.postMessage({ type: "progress", bytesDone, bytesTotal, gamesFound });
      },
      64 * 1024,
    )) {
      worker.postMessage({ type: "game", game });
    }
    worker.postMessage({ type: "complete" });
  } catch (error) {
    worker.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
