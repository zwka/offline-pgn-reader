import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { openSqliteConnection } from "../src/database.js";
import { SqliteIndex } from "../src/index.js";
import { LibraryService } from "../src/library.js";
import { readGameBytes } from "../src/scanner.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_GAME_COUNT = 1_000_000;
const MAX_GAME_COUNT = 10_000_000;
const BATCH_GAME_COUNT = 4_096;
const USAGE = `Usage: npm run benchmark -- [options]

Options:
  --games N  generated game records to scan (default: ${DEFAULT_GAME_COUNT})
  --keep    keep the temporary source and isolated Library data
  --json    print the measurement as JSON
  --help    show this message`;

export type BenchmarkOptions = {
  games: number;
  keep: boolean;
  json: boolean;
};

export type BenchmarkMeasurement = {
  sourceBytes: number;
  recordBytes: number;
  expectedGames: number;
  scannedGames: number;
  indexedRows: number;
  wallMs: number;
  peakRssBytes: number;
  recordsChecked: number;
  offsetsChecked: number;
  sourceSpansChecked: number;
  sourceSpansExpected: number;
};

export type BenchmarkRun = BenchmarkMeasurement & {
  temporaryDirectory: string;
};

type BenchmarkIndexRow = {
  idx_in_file: number;
  offset_start: number;
  offset_end: number;
  event: string;
  site: string;
  round: string;
  white: string;
  black: string;
  result: string;
};

export function parseBenchmarkOptions(args: readonly string[]): BenchmarkOptions {
  let games = DEFAULT_GAME_COUNT;
  let keep = false;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--keep") {
      keep = true;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--games") {
      games = parseGameCount(args[++index]);
      continue;
    }
    if (argument.startsWith("--games=")) {
      games = parseGameCount(argument.slice("--games=".length));
      continue;
    }
    throw new Error(`unknown benchmark option: ${argument}`);
  }

  return { games, keep, json };
}

export function createBenchmarkRecord(index: number, gameCount: number): Buffer {
  if (!Number.isInteger(index) || index < 0 || index >= gameCount) {
    throw new RangeError(`benchmark game index is outside 0..${gameCount - 1}: ${index}`);
  }
  const width = Math.max(4, String(gameCount - 1).length);
  const id = String(index).padStart(width, "0");
  return Buffer.from(
    [
      `[Event "Benchmark ${id}"]`,
      `[Site "Generated"]`,
      `[Round "${id}"]`,
      `[White "Player ${id}"]`,
      `[Black "Opponent ${id}"]`,
      `[Result "1-0"]`,
      "",
      "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0",
      "",
      "",
    ].join("\n"),
    "utf8",
  );
}

export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkRun> {
  const temporaryDirectory = mkdtempSync(join(REPOSITORY_ROOT, ".benchmark-scan-"));
  const sourcePath = join(temporaryDirectory, "representative.pgn");
  const databasePath = join(temporaryDirectory, "data", "index.sqlite3");

  try {
    const recordBytes = writeBenchmarkSource(sourcePath, options.games);
    const measurement = await runScanChild(
      sourcePath,
      databasePath,
      options.games,
      recordBytes,
    );
    return { ...measurement, temporaryDirectory };
  } finally {
    if (!options.keep) rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

function writeBenchmarkSource(path: string, gameCount: number): number {
  const recordBytes = createBenchmarkRecord(0, gameCount).byteLength;
  const descriptor = openSync(path, "wx");
  try {
    const batch = Buffer.allocUnsafe(recordBytes * BATCH_GAME_COUNT);
    let firstGame = 0;
    while (firstGame < gameCount) {
      const batchGames = Math.min(BATCH_GAME_COUNT, gameCount - firstGame);
      for (let offset = 0; offset < batchGames; offset += 1) {
        const record = createBenchmarkRecord(firstGame + offset, gameCount);
        if (record.byteLength !== recordBytes) {
          throw new Error(`benchmark record ${firstGame + offset} changed size`);
        }
        record.copy(batch, offset * recordBytes);
      }
      writeAll(descriptor, batch.subarray(0, batchGames * recordBytes));
      firstGame += batchGames;
    }
  } finally {
    closeSync(descriptor);
  }
  return recordBytes;
}

function writeAll(descriptor: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.byteLength) {
    const written = writeSync(descriptor, data, offset, data.byteLength - offset);
    if (written <= 0) throw new Error("benchmark source write made no progress");
    offset += written;
  }
}

function runScanChild(
  sourcePath: string,
  databasePath: string,
  gameCount: number,
  recordBytes: number,
): Promise<BenchmarkMeasurement> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        fileURLToPath(import.meta.url),
        "--child",
        sourcePath,
        databasePath,
        String(gameCount),
        String(recordBytes),
      ],
      { cwd: REPOSITORY_ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      errors += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        const detail = errors.trim() || output.trim() || `signal ${signal ?? "unknown"}`;
        reject(new Error(`benchmark scan process failed: ${detail}`));
        return;
      }
      try {
        resolve(JSON.parse(output) as BenchmarkMeasurement);
      } catch (error) {
        reject(new Error(`benchmark scan returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

async function runScanChildProcess(
  sourcePath: string,
  databasePath: string,
  gameCount: number,
  recordBytes: number,
): Promise<void> {
  const index = new SqliteIndex(databasePath);
  const service = new LibraryService(index, [], join(dirname(databasePath), "library"));
  let measurement: BenchmarkMeasurement;

  try {
    const registered = service.registerFile(sourcePath, false);
    const startedAt = performance.now();
    const file = await service.scanFileSync(registered.id, true);
    const wallMs = performance.now() - startedAt;
    const peakRssBytes = peakResidentSetBytes();

    if (file.scan_status !== "ready") {
      throw new Error(`production Scan ended with status ${file.scan_status}: ${file.scan_error ?? "unknown error"}`);
    }
    const verification = verifyIndex(
      index,
      sourcePath,
      file.id,
      gameCount,
      recordBytes,
    );
    measurement = {
      sourceBytes: statSync(sourcePath).size,
      recordBytes,
      expectedGames: gameCount,
      scannedGames: file.game_count,
      indexedRows: verification.indexedRows,
      wallMs,
      peakRssBytes,
      recordsChecked: verification.recordsChecked,
      offsetsChecked: verification.offsetsChecked,
      sourceSpansChecked: verification.sourceSpansChecked,
      sourceSpansExpected: verification.sourceSpansExpected,
    };
  } finally {
    await service.close();
  }

  process.stdout.write(JSON.stringify(measurement));
}

function verifyIndex(
  index: SqliteIndex,
  sourcePath: string,
  fileId: number,
  gameCount: number,
  recordBytes: number,
): {
  indexedRows: number;
  recordsChecked: number;
  offsetsChecked: number;
  sourceSpansChecked: number;
  sourceSpansExpected: number;
} {
  const file = index.getFile(fileId);
  if (!file) throw new Error(`benchmark file ${fileId} is missing from the Index`);
  if (file.game_count !== gameCount) {
    throw new Error(`Index game count ${file.game_count} does not equal ${gameCount}`);
  }
  const sourceBytes = statSync(sourcePath).size;
  if (sourceBytes !== gameCount * recordBytes) {
    throw new Error(`source size ${sourceBytes} does not equal ${gameCount * recordBytes}`);
  }

  const page = index.listGames(fileId, "", 0, 1);
  if (page.total !== gameCount || page.games.length !== 1) {
    throw new Error(`Index page reports ${page.total} records, expected ${gameCount}`);
  }

  const samples = new Set([0, Math.floor(gameCount / 2), gameCount - 1]);
  let indexedRows = 0;
  let sourceSpansChecked = 0;
  const database = openSqliteConnection(index.path);
  try {
    const rows = database
      .prepare(
        `SELECT idx_in_file, offset_start, offset_end, event, site, round,
           white, black, result
         FROM games WHERE file_id=? ORDER BY idx_in_file`,
      )
      .iterate(fileId) as Iterable<BenchmarkIndexRow>;

    for (const row of rows) {
      const expectedId = benchmarkId(row.idx_in_file, gameCount);
      const expectedStart = row.idx_in_file * recordBytes;
      const expectedEnd = expectedStart + recordBytes - 2;
      if (row.idx_in_file !== indexedRows) {
        throw new Error(`Index row ${indexedRows} has idx_in_file=${row.idx_in_file}`);
      }
      if (row.offset_start !== expectedStart || row.offset_end !== expectedEnd) {
        throw new Error(
          `Index row ${row.idx_in_file} has span ${row.offset_start}..${row.offset_end}, ` +
          `expected ${expectedStart}..${expectedEnd}`,
        );
      }
      if (
        row.event !== `Benchmark ${expectedId}` ||
        row.site !== "Generated" ||
        row.round !== expectedId ||
        row.white !== `Player ${expectedId}` ||
        row.black !== `Opponent ${expectedId}` ||
        row.result !== "1-0"
      ) {
        throw new Error(`Index row ${row.idx_in_file} has unexpected record fields`);
      }
      if (samples.has(row.idx_in_file)) {
        const expectedBytes = createBenchmarkRecord(row.idx_in_file, gameCount)
          .subarray(0, recordBytes - 2);
        const actualBytes = readGameBytes(
          sourcePath,
          row.offset_start,
          row.offset_end,
          recordBytes,
        );
        if (!actualBytes.equals(expectedBytes)) {
          throw new Error(`source bytes do not match Index span for row ${row.idx_in_file}`);
        }
        sourceSpansChecked += 1;
      }
      indexedRows += 1;
    }
  } finally {
    database.close();
  }

  if (indexedRows !== gameCount) {
    throw new Error(`Index contains ${indexedRows} rows, expected ${gameCount}`);
  }
  return {
    indexedRows,
    recordsChecked: indexedRows,
    offsetsChecked: indexedRows,
    sourceSpansChecked,
    sourceSpansExpected: samples.size,
  };
}

function benchmarkId(index: number, gameCount: number): string {
  return String(index).padStart(Math.max(4, String(gameCount - 1).length), "0");
}

function peakResidentSetBytes(): number {
  const maxRss = process.resourceUsage().maxRSS;
  return process.platform === "win32" ? maxRss : maxRss * 1024;
}

function parseGameCount(raw: string | undefined): number {
  const games = Number(raw);
  if (!Number.isSafeInteger(games) || games < 1 || games > MAX_GAME_COUNT) {
    throw new Error(`--games must be an integer between 1 and ${MAX_GAME_COUNT}`);
  }
  return games;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatMeasurement(run: BenchmarkRun, options: BenchmarkOptions): string {
  const seconds = run.wallMs / 1_000;
  const sourceMiB = run.sourceBytes / (1024 * 1024);
  const throughputMiB = sourceMiB / seconds;
  const throughputGames = run.scannedGames / seconds;
  return [
    "TypeScript production Scan benchmark",
    `source: generated PGN, ${formatInteger(run.expectedGames)} games, ${formatInteger(run.recordBytes)} bytes/game, ${sourceMiB.toFixed(1)} MiB`,
    "Library data: isolated temporary SQLite Index",
    `wall-clock time: ${seconds.toFixed(3)} s`,
    `peak RSS: ${(run.peakRssBytes / (1024 * 1024)).toFixed(1)} MiB`,
    `scanned game count: ${formatInteger(run.scannedGames)}`,
    `source-offset correctness: PASS (${formatInteger(run.offsetsChecked)}/${formatInteger(run.expectedGames)} Index rows)`,
    `Index records: PASS (${formatInteger(run.recordsChecked)}/${formatInteger(run.expectedGames)} expected records)`,
    `source-byte spans: PASS (${run.sourceSpansChecked}/${run.sourceSpansExpected} sampled first/middle/last spans)`,
    `throughput: ${throughputMiB.toFixed(1)} MiB/s, ${formatInteger(Math.round(throughputGames))} games/s`,
    `temporary data: ${options.keep ? `kept at ${run.temporaryDirectory}` : "removed"}`,
  ].join("\n");
}

async function main(args: readonly string[]): Promise<void> {
  if (args[0] === "--child") {
    if (args.length !== 5) throw new Error("invalid benchmark child arguments");
    await runScanChildProcess(args[1], args[2], Number(args[3]), Number(args[4]));
    return;
  }
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const options = parseBenchmarkOptions(args);

  const run = await runBenchmark(options);
  process.stdout.write(options.json
    ? `${JSON.stringify(run)}\n`
    : `${formatMeasurement(run, options)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`Benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
