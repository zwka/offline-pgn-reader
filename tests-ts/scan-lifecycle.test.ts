import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteIndex } from "../src/index.js";
import {
  LibraryService,
  type ScanWorker,
  type ScanWorkerFactory,
} from "../src/library.js";
import type { ScanWorkerData, ScanWorkerMessage } from "../src/scan-worker.js";

class ManualWorker implements ScanWorker {
  private readonly messages: Array<(message: ScanWorkerMessage) => void> = [];
  private readonly errors: Array<(error: Error) => void> = [];
  private readonly exits: Array<(code: number) => void> = [];
  terminated = false;

  on(event: "message", listener: (message: ScanWorkerMessage) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  on(
    event: "message" | "error" | "exit",
    listener: ((message: ScanWorkerMessage) => void) | ((error: Error) => void) | ((code: number) => void),
  ): this {
    if (event === "message") this.messages.push(listener as (message: ScanWorkerMessage) => void);
    if (event === "error") this.errors.push(listener as (error: Error) => void);
    if (event === "exit") this.exits.push(listener as (code: number) => void);
    return this;
  }

  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }

  send(message: ScanWorkerMessage): void {
    for (const listener of this.messages) listener(message);
  }

  fail(error: Error): void {
    for (const listener of this.errors) listener(error);
  }

  exit(code: number): void {
    for (const listener of this.exits) listener(code);
  }
}

const directories: string[] = [];
const services: LibraryService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  directories.splice(0).forEach((directory) => {
    rmSync(directory, { force: true, recursive: true });
  });
});

function testLibrary(
  workerFactory: ScanWorkerFactory,
): { directory: string; sourcePath: string; index: SqliteIndex; service: LibraryService } {
  const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-scan-lifecycle-"));
  directories.push(directory);
  const sourcePath = join(directory, "source.pgn");
  writeFileSync(sourcePath, '[Event "Lifecycle"]\n\n1. e4 *\n', "utf8");
  const index = new SqliteIndex(join(directory, "index.sqlite3"));
  const service = new LibraryService(
    index,
    [],
    join(directory, "library"),
    8 * 1024 * 1024,
    { workerFactory },
  );
  services.push(service);
  return { directory, sourcePath, index, service };
}

describe("Library Scan lifecycle", () => {
  it("owns duplicate prevention and exposes worker progress before completion", async () => {
    let worker: ManualWorker | undefined;
    const workerFactory: ScanWorkerFactory = (_data: ScanWorkerData) => {
      worker = new ManualWorker();
      return worker;
    };
    const { directory, sourcePath, index, service } = testLibrary(workerFactory);
    const file = service.registerFile(sourcePath, false);

    expect(service.startScan(file.id)).toBe(true);
    expect(service.startScan(file.id)).toBe(false);
    await expect(service.scanFileSync(file.id)).rejects.toThrow("scan already in progress");
    expect(service.getFile(file.id)).toMatchObject({
      scan_status: "scanning",
      progress: {
        bytesDone: 0,
        bytesTotal: Buffer.byteLength('[Event "Lifecycle"]\n\n1. e4 *\n'),
        gamesFound: 0,
      },
    });

    worker!.send({ type: "progress", bytesDone: 12, bytesTotal: 31, gamesFound: 1 });
    expect(service.getFile(file.id).progress).toEqual({
      bytesDone: 12,
      bytesTotal: 31,
      gamesFound: 1,
    });

    const database = new Database(index.path);
    try {
      database.prepare("UPDATE files SET scan_status='ready' WHERE id=?").run(file.id);
    } finally {
      database.close();
    }
    worker!.send({ type: "complete" });

    expect(service.getFile(file.id)).toMatchObject({ scan_status: "ready", progress: null });
    service.removeFile(file.id);
    expect(index.getFile(file.id)).toBeUndefined();
  });

  it("preserves the prior Index and records worker errors for a failed replacement", async () => {
    let index: SqliteIndex;
    const workerFactory: ScanWorkerFactory = (data: ScanWorkerData) => {
      const worker = new ManualWorker();
      void index.replaceGames(data.fileId, data.sourcePath, (bytesDone, bytesTotal, gamesFound) => {
        worker.send({ type: "progress", bytesDone, bytesTotal, gamesFound });
      }).then(
        () => worker.send({ type: "complete" }),
        (error: unknown) => worker.send({
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return worker;
    };
    const setup = testLibrary(workerFactory);
    index = setup.index;
    const { service } = setup;
    const file = service.registerFile(setup.sourcePath, false);

    expect((await service.scanFileSync(file.id)).scan_status).toBe("ready");
    const before = index.listGames(file.id);
    const database = new Database(index.path);
    try {
      database.exec(
        `CREATE TRIGGER reject_lifecycle_replacement BEFORE INSERT ON games
         WHEN NEW.file_id=${file.id}
         BEGIN SELECT RAISE(ABORT, 'lifecycle replacement rejected'); END;`,
      );
    } finally {
      database.close();
    }

    const failed = await service.scanFileSync(file.id, true);

    expect(failed).toMatchObject({
      scan_status: "error",
      scan_error: expect.stringContaining("lifecycle replacement rejected"),
    });
    expect(index.listGames(file.id)).toEqual(before);
  });

  it("settles a waiting Scan when persisted completion retires its worker", async () => {
    const workers: ManualWorker[] = [];
    const workerFactory: ScanWorkerFactory = () => {
      const worker = new ManualWorker();
      workers.push(worker);
      return worker;
    };
    const { directory, sourcePath, index, service } = testLibrary(workerFactory);
    const file = service.registerFile(sourcePath, false);

    const waiting = service.scanFileSync(file.id, true);
    const database = new Database(index.path);
    try {
      database.prepare("UPDATE files SET scan_status='ready' WHERE id=?").run(file.id);
    } finally {
      database.close();
    }

    expect(service.startScan(file.id, true)).toBe(true);
    await expect(waiting).resolves.toMatchObject({ id: file.id });
    expect(workers[0].terminated).toBe(true);
  });

  it("protects removal and reset, then makes an interrupted Scan retryable after shutdown", async () => {
    const workers: ManualWorker[] = [];
    const workerFactory: ScanWorkerFactory = () => {
      const worker = new ManualWorker();
      workers.push(worker);
      return worker;
    };
    const { directory, sourcePath, index, service } = testLibrary(workerFactory);
    const file = service.registerFile(sourcePath, false);

    const waiting = service.scanFileSync(file.id);
    expect(() => service.removeFile(file.id)).toThrow("cannot remove file while a scan is running");
    expect(() => service.resetIndex()).toThrow("cannot reset while a scan is running");

    await service.close();
    await expect(waiting).resolves.toMatchObject({ scan_status: "pending" });
    expect(index.getFile(file.id)).toMatchObject({ scan_status: "pending", scan_error: null });
    expect(workers[0].terminated).toBe(true);

    const restarted = new LibraryService(
      index,
      [],
      join(directory, "restarted-library"),
      8 * 1024 * 1024,
      { workerFactory },
    );
    services.push(restarted);
    expect(restarted.startScan(file.id)).toBe(true);
    expect(workers).toHaveLength(2);
  });
});
