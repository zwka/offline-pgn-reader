import type { ScannedGame } from "../scan.js";

export type MobileScanRequest = {
  type: "scan";
  source: Blob;
};

export type MobileScanMessage =
  | {
      type: "progress";
      bytesDone: number;
      bytesTotal: number;
      gamesFound: number;
    }
  | {
      type: "game";
      game: ScannedGame;
    }
  | {
      type: "complete";
    }
  | {
      type: "error";
      error: string;
    };
