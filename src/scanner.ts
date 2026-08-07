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
  let firstLine = true;

  const closeCurrent = (): ScannedGame | null => {
    if (!current) return null;
    current.offsetEnd = contentEnd;
    const done = current;
    current = null;
    return done;
  };

  for await (const raw of rawLines(path)) {
    const lineStart = offset;
    offset += raw.length;

    let rawForText = raw;
    if (firstLine) {
      firstLine = false;
      if (rawForText.subarray(0, BOM.length).equals(BOM)) {
        rawForText = rawForText.subarray(BOM.length);
      }
    }

    const text = rawForText.toString("utf8").replace(/[\r\n]+$/g, "");
    const blank = text.trim().length === 0;

    if (progress && offset >= nextProgress) {
      nextProgress = offset + progressEveryBytes;
      progress(offset, size, gamesFound);
    }

    if (blank) {
      if (current && current.headers.length > 0 && !hasMovetext) blankAfterTags = true;
      continue;
    }

    const tag = inComment ? null : parseTag(text);
    if (tag) {
      if (current && (hasMovetext || (blankAfterTags && tag[0] === "Event"))) {
        const done = closeCurrent();
        if (done) {
          gamesFound += 1;
          yield done;
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
      contentEnd = offset - trailingNewlineLength(raw);
      continue;
    }

    if (!inComment && raw.length > 0 && raw[0] === 0x25) continue;

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
    inComment = scanMovetextLine(text, inComment);
    contentEnd = offset - trailingNewlineLength(raw);
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
    const result = bytesRead === length ? data : data.subarray(0, bytesRead);
    return result.subarray(0, BOM.length).equals(BOM) ? result.subarray(BOM.length) : result;
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

async function* rawLines(path: string): AsyncGenerator<Buffer> {
  const stream = createReadStream(path);
  let pending = Buffer.alloc(0);

  for await (const chunk of stream) {
    const next = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let lineStart = 0;
    let newline = next.indexOf(0x0a, lineStart);
    while (newline >= 0) {
      yield next.subarray(lineStart, newline + 1);
      lineStart = newline + 1;
      newline = next.indexOf(0x0a, lineStart);
    }
    pending = next.subarray(lineStart);
  }

  if (pending.length > 0) yield pending;
}

function parseTag(text: string): TagPair | null {
  const match = /^\s*\[\s*([A-Za-z][A-Za-z0-9_]*)\s+"((?:[^"\\]|\\.)*)"\s*\]\s*$/.exec(text);
  if (!match) return null;
  return [match[1], unescapeTagValue(match[2])];
}

function unescapeTagValue(value: string): string {
  return value.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

function scanMovetextLine(line: string, inComment: boolean): boolean {
  if (inComment && !line.includes("}")) return true;
  if (!inComment && !line.includes("{") && !line.includes(";")) return false;
  for (const character of line) {
    if (inComment) {
      if (character === "}") inComment = false;
    } else if (character === "{") {
      inComment = true;
    } else if (character === ";") {
      break;
    }
  }
  return inComment;
}

function trailingNewlineLength(raw: Buffer): number {
  if (raw.length >= 2 && raw[raw.length - 2] === 0x0d && raw[raw.length - 1] === 0x0a) {
    return 2;
  }
  if (raw.length > 0 && (raw[raw.length - 1] === 0x0a || raw[raw.length - 1] === 0x0d)) {
    return 1;
  }
  return 0;
}

function readAtMost(descriptor: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length);
  const bytesRead = readSync(descriptor, buffer, 0, length, position);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}
