import {
  createReadStream,
  openSync,
  readSync,
  closeSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const DEFAULT_PROGRESS_BYTES = 4 * 1024 * 1024;
const MAX_TAG_LINE_BYTES = 64 * 1024;

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
  path: string,
  progress?: ScanProgress,
  progressEveryBytes = DEFAULT_PROGRESS_BYTES,
): AsyncGenerator<ScannedGame> {
  const size = statSync(path).size;
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
  let lineTooLong = false;
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
    lineTooLong = false;
    lineCommentAtStart = inComment;
    lineCommentState = inComment;
    lineStoppedAtSemicolon = false;
  };

  const processLine = (): ScannedGame | null => {
    const text = lineTooLong
      ? ""
      : Buffer.from(linePreview).toString("utf8").replace(/[\r\n]+$/g, "");
    const blank = !lineTooLong && text.trim().length === 0;

    if (blank) {
      if (current && current.headers.length > 0 && !hasMovetext) blankAfterTags = true;
      return null;
    }

    let completed: ScannedGame | null = null;
    const tag = lineCommentAtStart || lineTooLong ? null : parseTag(text);
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

  const processBytes = (bytes: Buffer): ScannedGame[] => {
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
      if (!lineTooLong) {
        if (linePreview.length < MAX_TAG_LINE_BYTES) linePreview.push(byte);
        else lineTooLong = true;
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
  let prefix = Buffer.alloc(0);
  let prefixResolved = false;
  for await (const chunk of createReadStream(path)) {
    let bytes = chunk as Buffer;
    if (!prefixResolved) {
      const needed = BOM.length - prefix.length;
      const prefixPart = bytes.subarray(0, needed);
      prefix = prefix.length === 0 ? Buffer.from(prefixPart) : Buffer.concat([prefix, prefixPart]);
      bytes = bytes.subarray(prefixPart.length);
      if (prefix.length < BOM.length) continue;
      prefixResolved = true;
      if (prefix.equals(BOM)) {
        offset = BOM.length;
      } else {
        bytes = Buffer.concat([prefix, bytes]);
      }
    }
    for (const done of processBytes(bytes)) yield done;
    if (progress && offset >= nextProgress) {
      nextProgress = offset + progressEveryBytes;
      progress(offset, size, gamesFound);
    }
  }

  if (!prefixResolved) {
    for (const done of processBytes(prefix)) yield done;
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

export function readGameBytes(
  path: string,
  offsetStart: number,
  offsetEnd: number,
  maxBytes: number,
): Buffer {
  const length = offsetEnd - offsetStart;
  if (length < 0 || length > maxBytes) {
    throw new Error(`invalid game span: ${offsetStart}..${offsetEnd} (max ${maxBytes})`);
  }
  const descriptor = openSync(path, "r");
  try {
    const data = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const count = readSync(descriptor, data, bytesRead, length - bytesRead, offsetStart + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    return bytesRead === length ? data : data.subarray(0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}

export function fingerprintFile(path: string, sampleBytes = 64 * 1024): string {
  const stats = statSync(path, { bigint: true });
  const hash = createHash("sha1");
  hash.update(`${stats.size}:${stats.mtimeNs}:`);
  const descriptor = openSync(path, "r");
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

function parseTag(text: string): TagPair | null {
  const match = /^\s*\[\s*([A-Za-z][A-Za-z0-9_]*)\s+"((?:[^"\\]|\\.)*)"\s*\]\s*$/.exec(text);
  if (!match) return null;
  return [match[1], unescapeTagValue(match[2])];
}

function unescapeTagValue(value: string): string {
  return value.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
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

function readAtMost(descriptor: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length);
  const bytesRead = readSync(descriptor, buffer, 0, length, position);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}
