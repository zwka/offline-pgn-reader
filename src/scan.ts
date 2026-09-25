import type { ByteSource } from "./byte-source.js";

const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const DEFAULT_PROGRESS_BYTES = 4 * 1024 * 1024;
const MAX_LINE_PREVIEW_BYTES = 64 * 1024;
const TAG_VALUE_START_RE = /^\s*\[\s*[A-Za-z][A-Za-z0-9_]*\s+"$/;

export type TagPair = [name: string, value: string];

export type ScannedGame = {
  idxInFile: number;
  offsetStart: number;
  offsetEnd: number;
  headers: TagPair[];
  warning: string | null;
};

export type ScanProgress = (bytesDone: number, bytesTotal: number, gamesFound: number) => void;

export async function* scanPgn(
  source: ByteSource,
  progress?: ScanProgress,
  progressEveryBytes = DEFAULT_PROGRESS_BYTES,
): AsyncGenerator<ScannedGame> {
  const size = source.size;
  let offset = 0;
  let nextProgress = progressEveryBytes;
  let current: ScannedGame | null = null;
  let hasMovetext = false;
  let blankAfterTags = false;
  let inComment = false;
  let contentEnd = 0;
  let gamesFound = 0;
  let lineStart = 0;
  let lineByteCount = 0;
  let lineFirstByte: number | null = null;
  let linePreviousByte = -1;
  let lineLastByte = -1;
  let linePreview: number[] = [];
  let linePreviewTruncated = false;
  let lineHasNonWhitespace = false;
  let lineMayBeTag = false;
  let lineTagValueStarted = false;
  let lineCommentAtStart = false;
  let lineCommentState = false;
  let lineStoppedAtSemicolon = false;

  const closeCurrent = (): ScannedGame | null => {
    if (!current) return null;
    current.offsetEnd = contentEnd;
    const done = current;
    current = null;
    return done;
  };

  const resetLine = (start: number): void => {
    lineStart = start;
    lineByteCount = 0;
    lineFirstByte = null;
    linePreviousByte = -1;
    lineLastByte = -1;
    linePreview = [];
    linePreviewTruncated = false;
    lineHasNonWhitespace = false;
    lineMayBeTag = false;
    lineTagValueStarted = false;
    lineCommentAtStart = inComment;
    lineCommentState = inComment;
    lineStoppedAtSemicolon = false;
  };

  const processLine = (): ScannedGame | null => {
    const text = linePreviewTruncated
      ? ""
      : decodeUtf8(linePreview).replace(/[\r\n]+$/g, "");
    const blank = !lineHasNonWhitespace || (!linePreviewTruncated && text.trim().length === 0);

    if (blank) {
      if (current && current.headers.length > 0 && !hasMovetext) blankAfterTags = true;
      return null;
    }

    let completed: ScannedGame | null = null;
    const tag = lineCommentAtStart || !lineMayBeTag || linePreviewTruncated ? null : parseTag(text);
    if (tag) {
      if (current && (hasMovetext || (blankAfterTags && tag[0] === "Event"))) {
        const done = closeCurrent();
        if (done) {
          gamesFound += 1;
          completed = done;
        }
      }
      if (!current) {
        current = {
          idxInFile: gamesFound,
          offsetStart: lineStart,
          offsetEnd: lineStart,
          headers: [],
          warning: null,
        };
        hasMovetext = false;
        blankAfterTags = false;
        inComment = false;
      }
      current.headers.push(tag);
      contentEnd = offset - trailingNewlineLength(linePreviousByte, lineLastByte);
      return completed;
    }

    if (!lineCommentAtStart && lineFirstByte === 0x25) {
      return completed;
    }

    if (!current) {
      current = {
        idxInFile: gamesFound,
        offsetStart: lineStart,
        offsetEnd: lineStart,
        headers: [],
        warning: "movetext with no tag section",
      };
      blankAfterTags = false;
    }
    hasMovetext = true;
    inComment = lineCommentState;
    contentEnd = offset - trailingNewlineLength(linePreviousByte, lineLastByte);
    return completed;
  };

  const processBytes = (bytes: Uint8Array): ScannedGame[] => {
    const completed: ScannedGame[] = [];
    for (const byte of bytes) {
      offset += 1;
      if (byte === 0x0a) {
        lineByteCount += 1;
        linePreviousByte = lineLastByte;
        lineLastByte = byte;
        const done = processLine();
        if (done) completed.push(done);
        resetLine(offset);
        continue;
      }

      lineByteCount += 1;
      linePreviousByte = lineLastByte;
      lineLastByte = byte;
      if (lineFirstByte === null) lineFirstByte = byte;
      if (!lineHasNonWhitespace && !isAsciiWhitespace(byte)) {
        lineHasNonWhitespace = true;
        lineMayBeTag = !lineCommentAtStart && byte === 0x5b;
      }
      if (!linePreviewTruncated) {
        linePreview.push(byte);
        if (lineMayBeTag && !lineTagValueStarted && byte === 0x22) {
          lineTagValueStarted = TAG_VALUE_START_RE.test(decodeUtf8(linePreview));
        }
        if (!lineTagValueStarted && linePreview.length >= MAX_LINE_PREVIEW_BYTES) {
          linePreviewTruncated = true;
        }
      }
      if (!lineStoppedAtSemicolon) {
        if (lineCommentState) {
          if (byte === 0x7d) lineCommentState = false;
        } else if (byte === 0x7b) {
          lineCommentState = true;
        } else if (byte === 0x3b) {
          lineStoppedAtSemicolon = true;
        }
      }
    }
    return completed;
  };

  resetLine(0);
  let prefix: number[] = [];
  let prefixResolved = false;
  for await (const chunk of source.stream()) {
    let bytes = chunk;
    if (!prefixResolved) {
      const needed = BOM.length - prefix.length;
      const prefixPart = bytes.subarray(0, needed);
      prefix = [...prefix, ...prefixPart];
      bytes = bytes.subarray(prefixPart.length);
      if (prefix.length < BOM.length) continue;
      prefixResolved = true;
      if (prefixEqualsBom(prefix)) {
        offset = BOM.length;
      } else {
        bytes = concatBytes(Uint8Array.from(prefix), bytes);
      }
    }
    for (const done of processBytes(bytes)) yield done;
    if (progress && offset >= nextProgress) {
      nextProgress = offset + progressEveryBytes;
      progress(offset, size, gamesFound);
    }
  }

  if (!prefixResolved) {
    for (const done of processBytes(Uint8Array.from(prefix))) yield done;
  }
  if (lineByteCount > 0) {
    const done = processLine();
    if (done) yield done;
  }

  const done = closeCurrent();
  if (done) {
    gamesFound += 1;
    yield done;
  }
  progress?.(size, size, gamesFound);
}

export { scanPgn as scanSource };

function parseTag(text: string): TagPair | null {
  const match = /^\s*\[\s*([A-Za-z][A-Za-z0-9_]*)\s+"((?:[^"\\]|\\.)*)"\s*\]\s*$/.exec(text);
  if (!match) return null;
  return [match[1], unescapeTagValue(match[2])];
}

function unescapeTagValue(value: string): string {
  return value.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

function decodeUtf8(bytes: readonly number[]): string {
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function prefixEqualsBom(prefix: readonly number[]): boolean {
  return prefix.length === BOM.length && BOM.every((byte, index) => prefix[index] === byte);
}

function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const result = new Uint8Array(first.byteLength + second.byteLength);
  result.set(first);
  result.set(second, first.byteLength);
  return result;
}

function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x09 || byte === 0x0b || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

function trailingNewlineLength(previousByte: number, lastByte: number): number {
  if (previousByte === 0x0d && lastByte === 0x0a) {
    return 2;
  }
  if (lastByte === 0x0a || lastByte === 0x0d) {
    return 1;
  }
  return 0;
}
