import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

let readsUntilMutation = 0;
let mutationPath: string | undefined;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readSync: ((
      descriptor: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position?: number,
    ) => {
      const bytesRead = actual.readSync(descriptor, buffer, offset, length, position ?? null);
      if (readsUntilMutation > 0) {
        readsUntilMutation -= 1;
        if (readsUntilMutation === 0 && mutationPath) {
          actual.appendFileSync(mutationPath, "\nchanged during read");
        }
      }
      return bytesRead;
    }) as typeof actual.readSync,
  };
});

const { readSourceSpan, sourceFingerprint, SourceChangedError } = await import("../src/source.js");

describe("Source read race protection", () => {
  it("rejects bytes changed after the read starts", () => {
    const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-source-race-"));
    mutationPath = join(directory, "source.pgn");
    writeFileSync(mutationPath, "[Event \"Race\"]\n\n1. e4 *\n", "utf8");
    const fingerprint = sourceFingerprint(mutationPath);
    readsUntilMutation = 2;

    try {
      expect(() => readSourceSpan(mutationPath!, 0, 10, 1024, fingerprint))
        .toThrowError(SourceChangedError);
    } finally {
      readsUntilMutation = 0;
      mutationPath = undefined;
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
