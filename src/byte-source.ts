export type ByteStream = AsyncIterable<Uint8Array>;

export interface ByteSource {
  readonly size: number;
  stream(): ByteStream;
}

export interface BoundedByteSource extends ByteSource {
  readSpan(
    offsetStart: number,
    offsetEnd: number,
    maxBytes: number,
  ): Uint8Array | PromiseLike<Uint8Array>;
}

export class SourceSpanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceSpanError";
  }
}

export function validateSourceSpan(
  offsetStart: number,
  offsetEnd: number,
  maxBytes: number,
): void {
  const validOffsets = Number.isSafeInteger(offsetStart) && Number.isSafeInteger(offsetEnd);
  if (!validOffsets || offsetStart < 0 || offsetEnd < offsetStart || offsetEnd - offsetStart > maxBytes) {
    throw new SourceSpanError(
      `invalid game span: ${offsetStart}..${offsetEnd} (max ${maxBytes})`,
    );
  }
}
