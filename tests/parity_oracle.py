"""Emit the Python compatibility snapshot consumed by the TypeScript parity test."""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient

from pgnreader.api import create_app
from pgnreader.config import Settings
from pgnreader.scanner import scan_pgn


FILE_KEYS = (
    "id",
    "path",
    "name",
    "size",
    "mtime_ns",
    "fingerprint",
    "game_count",
    "warning_count",
    "scan_status",
    "scan_error",
    "exists",
    "stale",
    "progress",
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    error_contract = json.loads(
        (args.fixture_root / "error_contract.json").read_text(encoding="utf-8")
    )
    settings = Settings(
        data_dir=args.data_dir,
        watch_dirs=[],
        upload_dir=args.data_dir / "library",
    )

    with TestClient(create_app(settings)) as client:
        sources = []
        for name in manifest["sources"]:
            sources.append(snapshot_source(client, args.fixture_root / name, name))

        wire = {
            "health": json_response(client.get("/api/health")),
            "notFound": json_response(client.get("/api/missing")),
        }
        errors = {
            "missingFile": json_response(client.get("/api/files/999999")),
            "missingGame": json_response(client.get("/api/games/999999")),
        }
        expected_errors = {
            name: value for name, value in error_contract.items()
        }
        for name, expected in expected_errors.items():
            if errors[name] != expected:
                raise RuntimeError(f"Python error contract failed for {name}: {errors[name]}")

        output = {
            "wire": wire,
            "errors": errors,
            "files": [
                file_contract(record)
                for record in client.get("/api/files").json()
            ],
            "sources": sources,
            "database": database_contract(settings.db_path),
        }

    print(json.dumps(output, ensure_ascii=False, separators=(",", ":")))


def snapshot_source(client: TestClient, path: Path, name: str) -> dict[str, Any]:
    scan = [
        {
            "idxInFile": game.idx_in_file,
            "offsetStart": game.offset_start,
            "offsetEnd": game.offset_end,
            "headers": [list(pair) for pair in game.headers],
            "warning": game.warning,
        }
        for game in scan_pgn(path)
    ]
    registered = client.post("/api/files", json={"path": str(path)})
    require_status(registered, 201)
    file_id = registered.json()["id"]
    ready = wait_for_ready(client, file_id)

    page_response = client.get(f"/api/files/{file_id}/games?limit=500")
    require_status(page_response, 200)
    page = page_response.json()
    documents = []
    tags = []
    sources = []
    for game in page["games"]:
        game_id = game["id"]
        document_response = client.get(f"/api/games/{game_id}")
        tag_response = client.get(f"/api/games/{game_id}/tags")
        source_response = client.get(f"/api/games/{game_id}/pgn")
        require_status(document_response, 200)
        require_status(tag_response, 200)
        require_status(source_response, 200)
        documents.append(canonical_document(document_response.json()))
        tags.append(tag_response.json())
        sources.append(source_response.text)

    return {
        "name": name,
        "scan": scan,
        "file": file_contract(ready),
        "page": page,
        "documents": documents,
        "tags": tags,
        "sources": sources,
    }


def wait_for_ready(client: TestClient, file_id: int) -> dict[str, Any]:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response = client.get(f"/api/files/{file_id}")
        require_status(response, 200)
        record = response.json()
        if record["scan_status"] in {"ready", "error"}:
            if record["scan_status"] == "error":
                raise RuntimeError(f"Python scan failed: {record}")
            return record
        time.sleep(0.01)
    raise TimeoutError(f"Python scan did not finish for file {file_id}")


def file_contract(record: dict[str, Any]) -> dict[str, Any]:
    return {key: record[key] for key in FILE_KEYS}


def json_response(response) -> dict[str, Any]:
    return {"status": response.status_code, "body": response.json()}


def require_status(response, expected: int) -> None:
    if response.status_code != expected:
        raise RuntimeError(
            f"expected HTTP {expected}, got {response.status_code}: {response.text}"
        )


def canonical_document(document: dict[str, Any]) -> dict[str, Any]:
    document["warnings"] = canonical_warnings(document["warnings"])
    for node in document["nodes"]:
        node["comment"] = normalize_comment(node["comment"])
        node["startingComment"] = normalize_comment(node["startingComment"])
    return document


def canonical_warnings(warnings: list[str]) -> list[str]:
    normalized = []
    for warning in warnings:
        if (
            "unrecognized movetext token" in warning
            or "could not parse PGN tree" in warning
            or "could not parse move" in warning
        ):
            normalized.append("malformed movetext")
        else:
            normalized.append(warning)
    return sorted(set(normalized))


def normalize_comment(comment: str) -> str:
    return re.sub(r"[\r\n]+", " ", comment)


def database_contract(path: Path) -> dict[str, Any]:
    with sqlite3.connect(path) as connection:
        connection.row_factory = sqlite3.Row
        tables = [
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            )
        ]
        columns = {
            table: [
                row[1]
                for row in connection.execute(f'PRAGMA table_info("{table}")')
            ]
            for table in tables
        }
        files = [
            dict(row)
            for row in connection.execute(
                "SELECT id, path, name, size, mtime_ns, fingerprint, game_count, "
                "warning_count, scan_status, scan_error FROM files ORDER BY id"
            )
        ]
        games = []
        for row in connection.execute(
            "SELECT id, file_id, idx_in_file, offset_start, offset_end, event, site, "
            "date, round, white, black, result, eco, opening, has_fen, tag_json, warning "
            "FROM games ORDER BY file_id, idx_in_file"
        ):
            game = dict(row)
            game["tag_json"] = json.loads(game["tag_json"])
            games.append(game)
        schema_version = connection.execute(
            "SELECT value FROM meta WHERE key='schema_version'"
        ).fetchone()[0]
    return {
        "schemaVersion": int(schema_version),
        "tables": tables,
        "columns": columns,
        "files": files,
        "games": games,
    }


if __name__ == "__main__":
    main()
