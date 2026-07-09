"""SQLite index store.

The database is a *cache* derived from source PGN files: it can be deleted and
rebuilt at any time. Connections are opened per operation (cheap for SQLite)
so background scan threads and request handlers never share a connection.
WAL mode allows concurrent readers while a scan thread writes.
"""

from __future__ import annotations

import logging
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from . import SCHEMA_VERSION

log = logging.getLogger("pgnreader.db")

_SCHEMA = """
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE files (
    id           INTEGER PRIMARY KEY,
    path         TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    size         INTEGER NOT NULL DEFAULT 0,
    mtime_ns     INTEGER NOT NULL DEFAULT 0,
    fingerprint  TEXT NOT NULL DEFAULT '',
    game_count   INTEGER NOT NULL DEFAULT 0,
    warning_count INTEGER NOT NULL DEFAULT 0,
    scan_status  TEXT NOT NULL DEFAULT 'pending',  -- pending|scanning|ready|error
    scan_error   TEXT,
    scanned_at   TEXT
);

CREATE TABLE games (
    id           INTEGER PRIMARY KEY,
    file_id      INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    idx_in_file  INTEGER NOT NULL,
    offset_start INTEGER NOT NULL,
    offset_end   INTEGER NOT NULL,
    event   TEXT NOT NULL DEFAULT '',
    site    TEXT NOT NULL DEFAULT '',
    date    TEXT NOT NULL DEFAULT '',
    round   TEXT NOT NULL DEFAULT '',
    white   TEXT NOT NULL DEFAULT '',
    black   TEXT NOT NULL DEFAULT '',
    result  TEXT NOT NULL DEFAULT '',
    eco     TEXT NOT NULL DEFAULT '',
    opening TEXT NOT NULL DEFAULT '',
    has_fen INTEGER NOT NULL DEFAULT 0,
    tag_json TEXT NOT NULL DEFAULT '{}',
    warning  TEXT
);

CREATE INDEX idx_games_file ON games(file_id, idx_in_file);
CREATE INDEX idx_games_white ON games(white);
CREATE INDEX idx_games_black ON games(black);
CREATE INDEX idx_games_event ON games(event);
"""


class Database:
    def __init__(self, path: Path):
        self.path = path

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA synchronous=NORMAL")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def initialize(self) -> None:
        """Create the schema, rebuilding the DB if the schema version differs."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        current = self._current_version()
        if current == SCHEMA_VERSION:
            return
        if current is not None:
            log.warning(
                "index schema version %s != expected %s; rebuilding cache DB", current, SCHEMA_VERSION
            )
            self.reset()
            return
        with self.connect() as conn:
            conn.executescript(_SCHEMA)
            conn.execute(
                "INSERT INTO meta(key, value) VALUES ('schema_version', ?)", (str(SCHEMA_VERSION),)
            )
        log.info("created index database at %s (schema v%s)", self.path, SCHEMA_VERSION)

    def _current_version(self) -> int | None:
        if not self.path.exists():
            return None
        try:
            with self.connect() as conn:
                row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
                return int(row["value"]) if row else -1
        except sqlite3.DatabaseError:
            return -1

    def reset(self) -> None:
        """Delete and recreate the index database."""
        for suffix in ("", "-wal", "-shm"):
            p = Path(str(self.path) + suffix)
            if p.exists():
                p.unlink()
        with self.connect() as conn:
            conn.executescript(_SCHEMA)
            conn.execute(
                "INSERT INTO meta(key, value) VALUES ('schema_version', ?)", (str(SCHEMA_VERSION),)
            )
        log.info("index database reset (schema v%s)", SCHEMA_VERSION)
