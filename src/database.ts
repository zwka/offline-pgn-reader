import Database from "better-sqlite3";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE files (
    id            INTEGER PRIMARY KEY,
    path          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    size          INTEGER NOT NULL DEFAULT 0,
    mtime_ns      INTEGER NOT NULL DEFAULT 0,
    fingerprint   TEXT NOT NULL DEFAULT '',
    game_count    INTEGER NOT NULL DEFAULT 0,
    warning_count INTEGER NOT NULL DEFAULT 0,
    scan_status   TEXT NOT NULL DEFAULT 'pending',
    scan_error    TEXT,
    scanned_at    TEXT
);

CREATE TABLE games (
    id           INTEGER PRIMARY KEY,
    file_id      INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    idx_in_file  INTEGER NOT NULL,
    offset_start INTEGER NOT NULL,
    offset_end   INTEGER NOT NULL,
    event        TEXT NOT NULL DEFAULT '',
    site         TEXT NOT NULL DEFAULT '',
    date         TEXT NOT NULL DEFAULT '',
    round        TEXT NOT NULL DEFAULT '',
    white        TEXT NOT NULL DEFAULT '',
    black        TEXT NOT NULL DEFAULT '',
    result       TEXT NOT NULL DEFAULT '',
    eco          TEXT NOT NULL DEFAULT '',
    opening      TEXT NOT NULL DEFAULT '',
    has_fen      INTEGER NOT NULL DEFAULT 0,
    tag_json     TEXT NOT NULL DEFAULT '{}',
    warning      TEXT
);

CREATE INDEX idx_games_file ON games(file_id, idx_in_file);
CREATE INDEX idx_games_white ON games(white);
CREATE INDEX idx_games_black ON games(black);
CREATE INDEX idx_games_event ON games(event);
`;

function openDatabase(path: string) {
  const database = new Database(path);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("synchronous = NORMAL");
  return database;
}

export type SqliteConnection = ReturnType<typeof openDatabase>;

export function openSqliteConnection(path: string): SqliteConnection {
  return openDatabase(path);
}

export class LibraryDatabase {
  constructor(public readonly path: string) {}

  initialize(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const database = openDatabase(this.path);
    try {
      const table = database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
        .get() as { name: string } | undefined;
      const version = table
        ? database
            .prepare("SELECT value FROM meta WHERE key='schema_version'")
            .get() as { value: string } | undefined
        : undefined;

      if (version?.value === String(SCHEMA_VERSION)) return;

      database.exec("DROP TABLE IF EXISTS games; DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS meta;");
      database.exec(SCHEMA);
      database
        .prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?)")
        .run(String(SCHEMA_VERSION));
    } finally {
      database.close();
    }
  }

  reset(): void {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(`${this.path}${suffix}`, { force: true });
    }
    this.initialize();
  }

  withConnection<T>(work: (database: SqliteConnection) => T): T {
    const database = openDatabase(this.path);
    try {
      return work(database);
    } finally {
      database.close();
    }
  }
}

export function createSqliteProbe(path: string): () => boolean {
  return () => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const database = new Database(path);
      try {
        database.prepare("SELECT 1").get();
        return true;
      } finally {
        database.close();
      }
    } catch {
      return false;
    }
  };
}
