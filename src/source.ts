import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync, readSync, statSync } from "node:fs";

import {
  SourceSpanError,
  type ByteSource,
  validateSourceSpan,
} from "./byte-source.js";

export { SourceSpanError } from "./byte-source.js";

const DEFAULT_SAMPLE_BYTES = 64 * 1024;

export type SourceStats = {
  size: number;
  mtimeNs: bigint;
};

type RawSourceStats = {
  size: bigint;
  mtimeNs: bigint;
};

export class SourceMissingError extends Error {
  constructor(public readonly path: string) {
    super(`source file missing: ${path}`);
    this.name = "SourceMissingError";
  }
}

export class SourceChangedError extends Error {
  constructor(public readonly path: string) {
    super(`source changed since scan: ${path}`);
    this.name = "SourceChangedError";
  }
}

export class FileByteSource implements ByteSource {
  constructor(public readonly path: string) {}

  get size(): number {
    return sourceStats(this.path).size;
  }

  stream(): AsyncIterable<Uint8Array> {
    return createReadStream(this.path) as AsyncIterable<Uint8Array>;
  }

  readSpan(offsetStart: number, offsetEnd: number, maxBytes: number): Buffer {
    return readSourceSpan(this.path, offsetStart, offsetEnd, maxBytes);
  }
}

export function createFileSource(path: string): FileByteSource {
  return new FileByteSource(path);
}

export function sourceStats(path: string): SourceStats {
  const stats = rawSourceStats(path);
  return { size: Number(stats.size), mtimeNs: stats.mtimeNs };
}

export function sourceFingerprint(path: string, sampleBytes = DEFAULT_SAMPLE_BYTES): string {
  const stats = rawSourceStats(path);
  const hash = createHash("sha1");
  hash.update(`${stats.size}:${stats.mtimeNs}:`);
  const descriptor = openSource(path);
  try {
    hash.update(readAtMost(descriptor, sampleBytes, 0));
    if (stats.size > BigInt(sampleBytes * 2)) {
      hash.update(readAtMost(descriptor, sampleBytes, Number(stats.size) - sampleBytes));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

export function readSourceSpan(
  path: string,
  offsetStart: number,
  offsetEnd: number,
  maxBytes: number,
  expectedFingerprint?: string,
): Buffer {
  validateSpan(offsetStart, offsetEnd, maxBytes);

  const before = sourceFingerprint(path);
  if (expectedFingerprint !== undefined && before !== expectedFingerprint) {
    throw new SourceChangedError(path);
  }

  const stats = sourceStats(path);
  if (offsetEnd > stats.size) {
    throw new SourceSpanError(
      `game span ${offsetStart}..${offsetEnd} exceeds source size ${stats.size}`,
    );
  }

  const length = offsetEnd - offsetStart;
  const descriptor = openSource(path);
  let data: Buffer | undefined;
  let readError: unknown;
  try {
    data = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const count = readSync(
        descriptor,
        data,
        bytesRead,
        length - bytesRead,
        offsetStart + bytesRead,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead !== length) {
      throw new SourceSpanError(`game span ${offsetStart}..${offsetEnd} could not be read`);
    }
  } catch (error) {
    readError = error;
  } finally {
    closeSync(descriptor);
  }

  const after = sourceFingerprint(path);
  if (before !== after || (expectedFingerprint !== undefined && after !== expectedFingerprint)) {
    throw new SourceChangedError(path);
  }
  if (readError) throw readError;
  if (!data) throw new SourceSpanError(`game span ${offsetStart}..${offsetEnd} could not be read`);
  return data;
}

function validateSpan(offsetStart: number, offsetEnd: number, maxBytes: number): void {
  validateSourceSpan(offsetStart, offsetEnd, maxBytes);
}

function rawSourceStats(path: string): RawSourceStats {
  try {
    const stats = statSync(path, { bigint: true });
    if (!stats.isFile()) throw new Error("not a regular file");
    return { size: stats.size, mtimeNs: stats.mtimeNs };
  } catch {
    throw new SourceMissingError(path);
  }
}

function openSource(path: string): number {
  try {
    return openSync(path, "r");
  } catch {
    throw new SourceMissingError(path);
  }
}

function readAtMost(descriptor: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length);
  const bytesRead = readSync(descriptor, buffer, 0, length, position);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}
