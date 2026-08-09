import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  readSourceSpan,
  sourceFingerprint,
  SourceChangedError,
  SourceMissingError,
  SourceSpanError,
} from "../src/source.js";

const directories: string[] = [];

afterEach(() => {
  directories.splice(0).forEach((directory) => {
    rmSync(directory, { force: true, recursive: true });
  });
});

function sourceFile(content = "0123456789") {
  const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-source-"));
  directories.push(directory);
  const path = join(directory, "source.pgn");
  writeFileSync(path, content, "utf8");
  return path;
}

describe("Source byte interface", () => {
  it("reads an exact bounded span and preserves source bytes", () => {
    const path = sourceFile("prefix\n[Event \"Round trip\"]\n\n1. e4 *\nsuffix");
    const source = readFileSync(path);
    const start = source.indexOf("[Event");
    const end = source.indexOf("suffix");
    const fingerprint = sourceFingerprint(path);

    expect(readSourceSpan(path, start, end, 1024, fingerprint)).toEqual(
      source.subarray(start, end),
    );
  });

  it("rejects spans outside the configured bound", () => {
    const path = sourceFile();

    expect(() => readSourceSpan(path, 0, 5, 4)).toThrowError(SourceSpanError);
    expect(() => readSourceSpan(path, 5, 4, 10)).toThrowError(SourceSpanError);
  });

  it("reports missing and changed sources clearly", () => {
    const path = sourceFile();
    const fingerprint = sourceFingerprint(path);

    writeFileSync(path, "changed", "utf8");
    expect(() => readSourceSpan(path, 0, 1, 10, fingerprint)).toThrowError(SourceChangedError);
    expect(() => readSourceSpan(join(path, "missing.pgn"), 0, 1, 10, fingerprint))
      .toThrowError(SourceMissingError);
  });
});
