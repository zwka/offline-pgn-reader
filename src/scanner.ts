import type { ByteSource } from "./byte-source.js";
import { scanPgn as scanByteSource } from "./scan.js";
import { FileByteSource } from "./source.js";
import type { ScanProgress, ScannedGame } from "./scan.js";

export {
  readSourceSpan as readGameBytes,
  sourceFingerprint as fingerprintFile,
} from "./source.js";

export type { ScanProgress, ScannedGame, TagPair } from "./scan.js";
export type { BoundedByteSource, ByteStream, ByteSource } from "./byte-source.js";
export { scanPgn as scanSource } from "./scan.js";

const DEFAULT_PROGRESS_BYTES = 4 * 1024 * 1024;

export async function* scanPgn(
  source: string | ByteSource,
  progress?: ScanProgress,
  progressEveryBytes = DEFAULT_PROGRESS_BYTES,
): AsyncGenerator<ScannedGame> {
  yield* scanByteSource(
    typeof source === "string" ? new FileByteSource(source) : source,
    progress,
    progressEveryBytes,
  );
}
