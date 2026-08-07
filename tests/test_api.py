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


def test_rescan_http_default_forces_while_false_preserves_internal_skip(client, fixture_copy):
    f = register(client, fixture_copy("basic_two_games.pgn"))

    skipped = client.post(f"/api/files/{f['id']}/rescan", params={"force": "false"})
    assert skipped.status_code == 200
    assert skipped.json()["scanStarted"] is False

    forced = client.post(f"/api/files/{f['id']}/rescan")
    assert forced.status_code == 200
    assert forced.json()["scanStarted"] is True
    assert wait_ready(client, f["id"])["scan_status"] == "ready"


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


def test_game_document_and_source_reads_reject_a_stale_index(client, fixture_copy):
    path = fixture_copy("basic_two_games.pgn")
    file_info = register(client, path)
    game_id = client.get(f"/api/files/{file_info['id']}/games").json()["games"][0]["id"]
    path.write_bytes(path.read_bytes() + b"\n")

    document = client.get(f"/api/games/{game_id}")
    source = client.get(f"/api/games/{game_id}/pgn")

    assert document.status_code == 409
    assert "changed" in document.json()["detail"]
    assert source.status_code == 409
    assert "changed" in source.json()["detail"]


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


def test_game_list_contract_defaults_paging_fields_and_bounds(client, tmp_path):
    source = tmp_path / "list-contract.pgn"
    source.write_text(
        '[Event "Contract Match"]\n[Site "Remote"]\n[Date "2024.02.02"]\n'
        '[Round "2"]\n[White "White Two"]\n[Black "Black Two"]\n'
        '[Result "*"]\n[ECO "D10"]\n[Opening "Queen Pawn"]\n\n1. d4 *\n',
        encoding="utf-8",
    )
    f = register(client, source)

    default_page = client.get(f"/api/files/{f['id']}/games")
    assert default_page.status_code == 200
    page = default_page.json()
    assert page["total"] == 1
    assert page["offset"] == 0
    assert page["limit"] == 100
    assert set(page["games"][0]) == {
        "id", "idx_in_file", "event", "site", "date", "round", "white", "black",
        "result", "eco", "opening", "has_fen", "warning", "byte_size",
    }
    assert page["games"][0] == {
        **page["games"][0],
        "idx_in_file": 0,
        "event": "Contract Match",
        "site": "Remote",
        "date": "2024.02.02",
        "round": "2",
        "white": "White Two",
        "black": "Black Two",
        "result": "*",
        "eco": "D10",
        "opening": "Queen Pawn",
        "has_fen": 0,
        "warning": None,
    }

    paged = client.get(
        f"/api/files/{f['id']}/games", params={"offset": 1, "limit": 1}
    )
    assert paged.json() == {"total": 1, "offset": 1, "limit": 1, "games": []}
    for query in (
        "White Two", "Black Two", "Contract Match", "Remote", "Queen Pawn", "D10", "2024.02.02"
    ):
        hits = client.get(f"/api/files/{f['id']}/games", params={"q": f"  {query}  "})
        assert hits.status_code == 200
        assert hits.json()["total"] == 1

    for params in (
        {"limit": 0},
        {"limit": 501},
        {"offset": -1},
        {"q": "x" * 201},
    ):
        assert client.get(f"/api/files/{f['id']}/games", params=params).status_code == 422


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
