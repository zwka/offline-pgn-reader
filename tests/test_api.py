"""API integration tests over the full stack (FastAPI TestClient)."""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from pgnreader.api import create_app

from .conftest import FIXTURES


@pytest.fixture
def client(settings):
    app = create_app(settings)
    with TestClient(app) as c:
        yield c


def wait_ready(client, file_id, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        f = client.get(f"/api/files/{file_id}").json()
        if f["scan_status"] in ("ready", "error"):
            return f
        time.sleep(0.05)
    raise TimeoutError("scan did not finish")


def register(client, path):
    r = client.post("/api/files", json={"path": str(path)})
    assert r.status_code == 201, r.text
    return wait_ready(client, r.json()["id"])


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok" and body["db"] is True


def test_register_scan_list_games(client, fixture_copy):
    f = register(client, fixture_copy("basic_two_games.pgn"))
    assert f["game_count"] == 2
    page = client.get(f"/api/files/{f['id']}/games").json()
    assert page["total"] == 2
    assert page["games"][0]["white"] == "Alpha, A."


def test_register_missing_path_404(client, tmp_path):
    r = client.post("/api/files", json={"path": str(tmp_path / "ghost.pgn")})
    assert r.status_code == 404


def test_game_document_and_neighbors(client, fixture_copy):
    f = register(client, fixture_copy("basic_two_games.pgn"))
    games = client.get(f"/api/files/{f['id']}/games").json()["games"]
    doc = client.get(f"/api/games/{games[0]['id']}").json()
    assert doc["nodes"][1]["san"] == "e4"
    assert doc["neighbors"]["next"] == games[1]["id"]
    assert doc["result"] == "1-0"
    assert doc["fileName"].endswith(".pgn")


def test_raw_pgn_endpoint_round_trip(client, fixture_copy):
    p = fixture_copy("basic_two_games.pgn")
    f = register(client, p)
    games = client.get(f"/api/files/{f['id']}/games").json()["games"]
    r = client.get(f"/api/games/{games[1]['id']}/pgn")
    assert r.status_code == 200
    assert r.text.startswith('[Event "Test Open"]')
    assert r.text in p.read_text(encoding="utf-8")


def test_search_query(client, fixture_copy):
    f = register(client, fixture_copy("basic_two_games.pgn"))
    hits = client.get(f"/api/files/{f['id']}/games", params={"q": "alpha"}).json()
    assert hits["total"] == 2  # matches white in one game, black in other
    none = client.get(f"/api/files/{f['id']}/games", params={"q": "zzz"}).json()
    assert none["total"] == 0


def test_upload(client):
    content = (FIXTURES / "fen_start.pgn").read_bytes()
    r = client.post(
        "/api/files/upload",
        files={"file": ("my study.pgn", content, "application/x-chess-pgn")},
    )
    assert r.status_code == 201
    f = wait_ready(client, r.json()["id"])
    assert f["game_count"] == 1


def test_discover(client, settings, fixture_copy):
    watch = settings.watch_dirs[0]
    watch.mkdir(parents=True, exist_ok=True)
    (watch / "found.pgn").write_bytes((FIXTURES / "basic_two_games.pgn").read_bytes())
    found = client.get("/api/discover").json()
    assert any(d["name"] == "found.pgn" and not d["registered"] for d in found)


def test_delete_file(client, fixture_copy):
    f = register(client, fixture_copy("basic_two_games.pgn"))
    assert client.delete(f"/api/files/{f['id']}").status_code == 204
    assert client.get(f"/api/files/{f['id']}").status_code == 404


def test_admin_reset(client, fixture_copy):
    register(client, fixture_copy("basic_two_games.pgn"))
    assert client.post("/api/admin/reset").status_code == 200
    assert client.get("/api/files").json() == []


def test_unknown_game_404(client):
    assert client.get("/api/games/99999").status_code == 404


def test_frontend_served(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "PGN Reader" in r.text
