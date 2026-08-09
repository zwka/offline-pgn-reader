import { describe, expect, it } from "vitest";

import { createBenchmarkRecord } from "../benchmarks/scan.js";

describe("production Scan benchmark source", () => {
  it("creates fixed-size records with byte-stable source boundaries", () => {
    const gameCount = 128;
    const first = createBenchmarkRecord(0, gameCount);
    const middle = createBenchmarkRecord(64, gameCount);
    const last = createBenchmarkRecord(gameCount - 1, gameCount);

    expect(middle.byteLength).toBe(first.byteLength);
    expect(last.byteLength).toBe(first.byteLength);
    expect(first.toString("utf8")).toContain('[Event "Benchmark 0000"]');
    expect(last.toString("utf8")).toContain('[Event "Benchmark 0127"]');
    expect(first.subarray(0, first.byteLength - 2).toString("utf8")).toMatch(/1-0$/);
  });
});
