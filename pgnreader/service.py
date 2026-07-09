"""Application layer: library management, scan orchestration, game retrieval.

Scans run on background threads (one per file, never two for the same file)
and report progress through an in-process registry that the API merges into
file responses. All SQLite access goes through short-lived connections, so
scan threads and request handlers never contend on a shared connection.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import Settings
from .db import Database
from .parser import GameParseError, hydrate_game
from .scanner import ScannedGame, fingerprint_file, read_game_bytes, scan_pgn

log = logging.getLogger("pgnreader.service")

_INSERT_BATCH = 500

# Tags surfaced in the index header columns (Seven Tag Roster is guaranteed
# storage; extras help browsing/search).
_ROSTER = ("Event", "Site", "Date", "Round", "White", "Black", "Result")


class ServiceError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class NotFound(ServiceError):
    def __init__(self, message: str):
        super().__init__(message, status=404)


@dataclass
class ScanProgress:
    bytes_done: int = 0
    bytes_total: int = 0
    games_found: int = 0
    started_at: float = 0.0


class LibraryService:
    def __init__(self, db: Database, settings: Settings):
        self.db = db
        self.settings = settings
        self._progress: dict[int, ScanProgress] = {}
        self._active_scans: set[int] = set()
        self._lock = threading.Lock()

    # ------------------------------------------------------------- files

    def register_file(self, path: str | Path, scan: bool = True) -> dict[str, Any]:
        p = Path(path).expanduser().resolve()
        if not p.is_file():
            raise ServiceError(f"not a file: {p}", status=404)
        if p.suffix.lower() != ".pgn":
            raise ServiceError(f"not a .pgn file: {p.name}", status=422)
        with self.db.connect() as conn:
            row = conn.execute("SELECT id FROM files WHERE path=?", (str(p),)).fetchone()
            if row:
                file_id = row["id"]
            else:
                cur = conn.execute(
                    "INSERT INTO files(path, name) VALUES (?, ?)", (str(p), p.name)
                )
                file_id = cur.lastrowid
                log.info("registered file #%s: %s", file_id, p)
        if scan:
            self.start_scan(file_id)
        return self.get_file(file_id)

    def upload_file(self, filename: str, content: bytes) -> dict[str, Any]:
        safe = re.sub(r"[^\w\s.\-()]", "_", Path(filename).name).strip() or "upload.pgn"
        if not safe.lower().endswith(".pgn"):
            safe += ".pgn"
        self.settings.upload_dir.mkdir(parents=True, exist_ok=True)
        target = self.settings.upload_dir / safe
        stem, suffix, n = target.stem, target.suffix, 1
        while target.exists():
            target = self.settings.upload_dir / f"{stem}-{n}{suffix}"
            n += 1
        target.write_bytes(content)
        log.info("uploaded %s (%d bytes)", target, len(content))
        return self.register_file(target)

    def discover(self) -> list[dict[str, Any]]:
        with self.db.connect() as conn:
            registered = {row["path"] for row in conn.execute("SELECT path FROM files")}
        found: list[dict[str, Any]] = []
        seen: set[str] = set()
        for d in self.settings.watch_dirs:
            if not d.is_dir():
                continue
            for p in sorted(d.rglob("*.pgn")):
                rp = str(p.resolve())
                if rp in seen:
                    continue
                seen.add(rp)
                found.append(
                    {
                        "path": rp,
                        "name": p.name,
                        "size": p.stat().st_size,
                        "registered": rp in registered,
                    }
                )
        return found

    def list_files(self) -> list[dict[str, Any]]:
        with self.db.connect() as conn:
            rows = conn.execute("SELECT * FROM files ORDER BY name").fetchall()
        return [self._file_dict(r) for r in rows]

    def get_file(self, file_id: int) -> dict[str, Any]:
        with self.db.connect() as conn:
            row = conn.execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone()
        if row is None:
            raise NotFound(f"file {file_id} not found")
        return self._file_dict(row)

    def remove_file(self, file_id: int) -> None:
        with self.db.connect() as conn:
            cur = conn.execute("DELETE FROM files WHERE id=?", (file_id,))
            if cur.rowcount == 0:
                raise NotFound(f"file {file_id} not found")
        log.info("unregistered file #%s (source file untouched)", file_id)

    def _file_dict(self, row) -> dict[str, Any]:
        d = dict(row)
        p = Path(d["path"])
        d["exists"] = p.is_file()
        d["stale"] = False
        if d["exists"] and d["scan_status"] == "ready":
            st = p.stat()
            d["stale"] = st.st_size != d["size"] or st.st_mtime_ns != d["mtime_ns"]
        prog = self._progress.get(d["id"])
        if prog and d["scan_status"] == "scanning":
            d["progress"] = {
                "bytesDone": prog.bytes_done,
                "bytesTotal": prog.bytes_total,
                "gamesFound": prog.games_found,
            }
        else:
            d["progress"] = None
        return d

    # ------------------------------------------------------------- scanning

    def start_scan(self, file_id: int, force: bool = False) -> bool:
        """Kick off a background scan. Returns False if one is already running."""
        self.get_file(file_id)  # 404 if unknown
        with self._lock:
            if file_id in self._active_scans:
                return False
            self._active_scans.add(file_id)
        t = threading.Thread(
            target=self._scan_worker, args=(file_id, force), name=f"scan-{file_id}", daemon=True
        )
        t.start()
        return True

    def scan_file_sync(self, file_id: int, force: bool = False) -> dict[str, Any]:
        """Blocking scan (CLI and tests)."""
        with self._lock:
            if file_id in self._active_scans:
                raise ServiceError("scan already in progress", status=409)
            self._active_scans.add(file_id)
        self._scan_worker(file_id, force)
        return self.get_file(file_id)

    def _scan_worker(self, file_id: int, force: bool) -> None:
        try:
            self._do_scan(file_id, force)
        except Exception as exc:
            log.exception("scan of file #%s failed", file_id)
            with self.db.connect() as conn:
                conn.execute(
                    "UPDATE files SET scan_status='error', scan_error=? WHERE id=?",
                    (str(exc), file_id),
                )
        finally:
            with self._lock:
                self._active_scans.discard(file_id)
            self._progress.pop(file_id, None)

    def _do_scan(self, file_id: int, force: bool) -> None:
        info = self.get_file(file_id)
        path = Path(info["path"])
        if not path.is_file():
            raise ServiceError(f"source file missing: {path}", status=404)

        fp = fingerprint_file(path)
        if not force and info["scan_status"] == "ready" and info["fingerprint"] == fp:
            log.info("file #%s unchanged (fingerprint match), skipping scan", file_id)
            return

        st = path.stat()
        progress = ScanProgress(bytes_total=st.st_size, started_at=time.time())
        self._progress[file_id] = progress

        def on_progress(done: int, total: int, games: int) -> None:
            progress.bytes_done, progress.bytes_total, progress.games_found = done, total, games

        log.info("scanning file #%s: %s (%d bytes)", file_id, path, st.st_size)
        with self.db.connect() as conn:
            conn.execute(
                "UPDATE files SET scan_status='scanning', scan_error=NULL WHERE id=?", (file_id,)
            )
        t0 = time.perf_counter()
        batch: list[tuple] = []
        count = warning_count = 0

        with self.db.connect() as conn:
            conn.execute("DELETE FROM games WHERE file_id=?", (file_id,))
            for g in scan_pgn(path, progress=on_progress):
                batch.append(self._game_row(file_id, g))
                count += 1
                if g.warning:
                    warning_count += 1
                if len(batch) >= _INSERT_BATCH:
                    self._insert_games(conn, batch)
                    batch.clear()
            if batch:
                self._insert_games(conn, batch)
            conn.execute(
                """UPDATE files SET size=?, mtime_ns=?, fingerprint=?, game_count=?,
                   warning_count=?, scan_status='ready', scan_error=NULL,
                   scanned_at=datetime('now') WHERE id=?""",
                (st.st_size, st.st_mtime_ns, fp, count, warning_count, file_id),
            )
        log.info(
            "scan of file #%s done: %d games (%d warnings) in %.2fs",
            file_id, count, warning_count, time.perf_counter() - t0,
        )

    @staticmethod
    def _game_row(file_id: int, g: ScannedGame) -> tuple:
        tags = dict(g.headers)
        return (
            file_id, g.idx_in_file, g.offset_start, g.offset_end,
            tags.get("Event", ""), tags.get("Site", ""), tags.get("Date", ""),
            tags.get("Round", ""), tags.get("White", ""), tags.get("Black", ""),
            tags.get("Result", ""), tags.get("ECO", ""), tags.get("Opening", ""),
            1 if "FEN" in tags else 0,
            json.dumps(g.headers, ensure_ascii=False),
            g.warning,
        )

    @staticmethod
    def _insert_games(conn, batch: list[tuple]) -> None:
        conn.executemany(
            """INSERT INTO games(file_id, idx_in_file, offset_start, offset_end,
               event, site, date, round, white, black, result, eco, opening,
               has_fen, tag_json, warning)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            batch,
        )

    # ------------------------------------------------------------- games

    def list_games(
        self, file_id: int, q: str = "", offset: int = 0, limit: int = 100
    ) -> dict[str, Any]:
        self.get_file(file_id)
        limit = max(1, min(limit, 500))
        where = "file_id=?"
        params: list[Any] = [file_id]
        if q.strip():
            like = f"%{q.strip()}%"
            where += """ AND (white LIKE ? OR black LIKE ? OR event LIKE ?
                         OR site LIKE ? OR opening LIKE ? OR eco LIKE ? OR date LIKE ?)"""
            params += [like] * 7
        with self.db.connect() as conn:
            total = conn.execute(f"SELECT COUNT(*) c FROM games WHERE {where}", params).fetchone()["c"]
            rows = conn.execute(
                f"""SELECT id, idx_in_file, event, site, date, round, white, black,
                    result, eco, opening, has_fen, warning,
                    offset_end - offset_start AS byte_size
                    FROM games WHERE {where} ORDER BY idx_in_file LIMIT ? OFFSET ?""",
                params + [limit, offset],
            ).fetchall()
        return {
            "total": total,
            "offset": offset,
            "limit": limit,
            "games": [dict(r) for r in rows],
        }

    def _game_row_by_id(self, game_id: int):
        with self.db.connect() as conn:
            row = conn.execute(
                """SELECT g.*, f.path AS file_path, f.name AS file_name
                   FROM games g JOIN files f ON f.id = g.file_id WHERE g.id=?""",
                (game_id,),
            ).fetchone()
        if row is None:
            raise NotFound(f"game {game_id} not found")
        return row

    def get_game_source(self, game_id: int) -> str:
        row = self._game_row_by_id(game_id)
        path = Path(row["file_path"])
        if not path.is_file():
            raise ServiceError(f"source file missing: {path}", status=409)
        data = read_game_bytes(
            path, row["offset_start"], row["offset_end"], self.settings.max_game_bytes
        )
        return data.decode("utf-8", errors="replace")

    def get_game_document(self, game_id: int) -> dict[str, Any]:
        row = self._game_row_by_id(game_id)
        path = Path(row["file_path"])
        if not path.is_file():
            raise ServiceError(f"source file missing: {path}", status=409)
        extra = [f"index warning: {row['warning']}"] if row["warning"] else []
        data = read_game_bytes(
            path, row["offset_start"], row["offset_end"], self.settings.max_game_bytes
        )
        try:
            doc = hydrate_game(data, extra_warnings=extra)
        except GameParseError as exc:
            raise ServiceError(f"game could not be parsed: {exc}", status=422) from exc
        out = doc.to_dict()
        out["gameId"] = game_id
        out["fileId"] = row["file_id"]
        out["fileName"] = row["file_name"]
        out["idxInFile"] = row["idx_in_file"]
        return out

    def neighbor_game_ids(self, game_id: int) -> dict[str, int | None]:
        """Previous/next game in the same file, for reader navigation."""
        row = self._game_row_by_id(game_id)
        with self.db.connect() as conn:
            prev = conn.execute(
                "SELECT id FROM games WHERE file_id=? AND idx_in_file<? ORDER BY idx_in_file DESC LIMIT 1",
                (row["file_id"], row["idx_in_file"]),
            ).fetchone()
            nxt = conn.execute(
                "SELECT id FROM games WHERE file_id=? AND idx_in_file>? ORDER BY idx_in_file LIMIT 1",
                (row["file_id"], row["idx_in_file"]),
            ).fetchone()
        return {"prev": prev["id"] if prev else None, "next": nxt["id"] if nxt else None}

    # ------------------------------------------------------------- admin

    def reset_index(self) -> None:
        with self._lock:
            if self._active_scans:
                raise ServiceError("cannot reset while a scan is running", status=409)
        self.db.reset()
        log.warning("index database reset by request")
