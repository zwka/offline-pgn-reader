"""HTTP API and static frontend hosting (local-only)."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from .config import Settings, settings as default_settings
from .db import Database
from .logging_setup import configure_logging
from .service import LibraryService, ServiceError

log = logging.getLogger("pgnreader.api")

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


class RegisterFileRequest(BaseModel):
    path: str = Field(min_length=1, description="Absolute or ~-relative path to a .pgn file")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or default_settings
    configure_logging(settings)
    settings.ensure_dirs()

    db = Database(settings.db_path)
    db.initialize()
    service = LibraryService(db, settings)

    app = FastAPI(title="Offline PGN Reader", version=__version__, docs_url="/api/docs",
                  openapi_url="/api/openapi.json")
    app.state.service = service
    app.state.settings = settings

    @app.exception_handler(ServiceError)
    async def service_error_handler(_req: Request, exc: ServiceError):
        return JSONResponse(status_code=exc.status, content={"detail": str(exc)})

    # ------------------------------------------------------------- api

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        db_ok = True
        try:
            with db.connect() as conn:
                conn.execute("SELECT 1")
        except Exception:
            db_ok = False
        return {"status": "ok" if db_ok else "degraded", "version": __version__, "db": db_ok}

    @app.get("/api/files")
    def list_files() -> list[dict[str, Any]]:
        return service.list_files()

    @app.post("/api/files", status_code=201)
    def register_file(body: RegisterFileRequest) -> dict[str, Any]:
        return service.register_file(body.path)

    @app.post("/api/files/upload", status_code=201)
    async def upload_file(file: UploadFile = File(...)) -> dict[str, Any]:
        content = await file.read()
        return service.upload_file(file.filename or "upload.pgn", content)

    @app.get("/api/discover")
    def discover() -> list[dict[str, Any]]:
        return service.discover()

    @app.get("/api/files/{file_id}")
    def get_file(file_id: int) -> dict[str, Any]:
        return service.get_file(file_id)

    @app.post("/api/files/{file_id}/rescan")
    def rescan(file_id: int, force: bool = True) -> dict[str, Any]:
        started = service.start_scan(file_id, force=force)
        out = service.get_file(file_id)
        out["scanStarted"] = started
        return out

    @app.delete("/api/files/{file_id}", status_code=204)
    def remove_file(file_id: int) -> None:
        service.remove_file(file_id)

    @app.get("/api/files/{file_id}/games")
    def list_games(
        file_id: int,
        q: str = Query("", max_length=200),
        offset: int = Query(0, ge=0),
        limit: int = Query(100, ge=1, le=500),
    ) -> dict[str, Any]:
        return service.list_games(file_id, q=q, offset=offset, limit=limit)

    @app.get("/api/games/{game_id}")
    def get_game(game_id: int) -> dict[str, Any]:
        doc = service.get_game_document(game_id)
        doc["neighbors"] = service.neighbor_game_ids(game_id)
        return doc

    @app.get("/api/games/{game_id}/pgn", response_class=PlainTextResponse)
    def get_game_pgn(game_id: int) -> str:
        return service.get_game_source(game_id)

    @app.get("/api/games/{game_id}/tags")
    def get_game_tags(game_id: int) -> list[list[str]]:
        row = service._game_row_by_id(game_id)
        return json.loads(row["tag_json"])

    @app.post("/api/admin/reset")
    def reset_index() -> dict[str, str]:
        service.reset_index()
        return {"status": "reset"}

    # ------------------------------------------------------------- frontend

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(FRONTEND_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

    return app
