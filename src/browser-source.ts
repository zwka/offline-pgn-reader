import {
  SourceSpanError,
  type BoundedByteSource,
  validateSourceSpan,
} from "./byte-source.js";

export { SourceSpanError } from "./byte-source.js";

export class BlobSource implements BoundedByteSource {
  constructor(public readonly blob: Blob) {}

  get size(): number {
    return this.blob.size;
  }

  stream(): AsyncIterable<Uint8Array> {
    return readBlobChunks(this.blob);
  }

  async readSpan(offsetStart: number, offsetEnd: number, maxBytes: number): Promise<Uint8Array> {
    validateSourceSpan(offsetStart, offsetEnd, maxBytes);
    if (offsetEnd > this.size) {
      throw new SourceSpanError(
        `game span ${offsetStart}..${offsetEnd} exceeds source size ${this.size}`,
      );
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(
        await this.blob.slice(offsetStart, offsetEnd).arrayBuffer(),
      );
    } catch {
      throw new SourceSpanError(`game span ${offsetStart}..${offsetEnd} could not be read`);
    }
    if (bytes.byteLength !== offsetEnd - offsetStart) {
      throw new SourceSpanError(`game span ${offsetStart}..${offsetEnd} could not be read`);
    }
    return bytes;
  }
}

export { BlobSource as BrowserByteSource, BlobSource as BrowserSource };

export function createBlobSource(blob: Blob): BlobSource {
  return new BlobSource(blob);
}

export async function readBlobSpan(
  blob: Blob,
  offsetStart: number,
  offsetEnd: number,
  maxBytes: number,
): Promise<Uint8Array> {
  return new BlobSource(blob).readSpan(offsetStart, offsetEnd, maxBytes);
}

async function* readBlobChunks(blob: Blob): AsyncGenerator<Uint8Array> {
  const reader = blob.stream().getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      if (result.value.byteLength > 0) yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}
