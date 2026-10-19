import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let artifactDirectory: string | undefined;

afterEach(() => {
  if (!artifactDirectory) return;
  rmSync(artifactDirectory, { force: true, recursive: true });
  artifactDirectory = undefined;
});

describe("documentation checks", () => {
  it("ignores preserved Markdown diagnostics under .artifacts", () => {
    const artifactRoot = resolve(repositoryRoot, ".artifacts");
    mkdirSync(artifactRoot, { recursive: true });
    artifactDirectory = mkdtempSync(join(artifactRoot, "check-docs-"));
    writeFileSync(join(artifactDirectory, "error-context.md"), "[missing](missing-target.md)\n");

    const result = spawnSync(
      process.execPath,
      [resolve(repositoryRoot, "scripts/check-docs.mjs")],
      { cwd: repositoryRoot, encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("check-docs: PASS");
  });
});
