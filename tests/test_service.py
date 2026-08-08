"""Service-layer tests: registration, scanning, re-scan, retrieval, search."""

from __future__ import annotations

import json
import os
import time

import pytest

import pgnreader.service as service_module
from pgnreader import SCHEMA_VERSION
from pgnreader.db import Database
from pgnreader.service import LibraryService, NotFound, ServiceError

from .conftest import FIXTURES


def register_and_scan(service, path):
    info = service.register_file(path, scan=False)
    return service.scan_file_sync(info["id"])


def test_register_and_scan(service, fixture_copy):
    p = fixture_copy("basic_two_games.pgn")
    info = register_and_scan(service, p)
    assert info["scan_status"] == "ready"
    assert info["game_count"] == 2
    assert info["warning_count"] == 0


def test_register_rejects_bad_paths(service, tmp_path):
    with pytest.raises(ServiceError):
        service.register_file(tmp_path / "nope.pgn")
    txt = tmp_path / "notes.txt"
    txt.write_text("hi")
    with pytest.raises(ServiceError):
        service.register_file(txt)


def test_register_same_path_is_idempotent(service, fixture_copy):
    p = fixture_copy("basic_two_games.pgn")
    a = service.register_file(p, scan=False)
    b = service.register_file(p, scan=False)
    assert a["id"] == b["id"]
    assert len(service.list_files()) == 1


def test_unchanged_file_skips_rescan(service, fixture_copy):
    p = fixture_copy("basic_two_games.pgn")
    info = register_and_scan(service, p)
    first_scan_time = info["scanned_at"]
    info2 = service.scan_file_sync(info["id"])  # fingerprint match -> skip
    assert info2["scanned_at"] == first_scan_time


def test_duplicate_background_scan_requests_return_false(service, fixture_copy):
    p = fixture_copy("basic_two_games.pgn")
    info = service.register_file(p, scan=False)

    assert service.start_scan(info["id"]) is True
    assert service.start_scan(info["id"]) is False
    deadline = time.time() + 10
    while time.time() < deadline:
        if service.get_file(info["id"])["scan_status"] in {"ready", "error"}:
            break
        time.sleep(0.01)
    assert service.get_file(info["id"])["scan_status"] == "ready"


def test_changed_file_marked_stale_and_rescan_updates(service, fixture_copy):
    p = fixture_copy("basic_two_games.pgn")
    info = register_and_scan(service, p)
    assert info["stale"] is False

    with p.open("a", encoding="utf-8") as f:
        f.write(
            '\n[Event "Third"]\n[Site "?"]\n[Date "?"]\n[Round "3"]\n'
            '[White "New"]\n[Black "Game"]\n[Result "*"]\n\n1. g3 *\n'
        )
    os.utime(p)
    assert service.get_file(info["id"])["stale"] is True

    info2 = service.scan_file_sync(info["id"])
    assert info2["game_count"] == 3
    assert info2["stale"] is False
    games = service.list_games(info["id"])["games"]
    assert games[-1]["white"] == "New"


def test_stale_source_reads_are_blocked_until_rescan(service, fixture_copy):
    p = fixture_copy("basic_two_games.pgn")
    info = register_and_scan(service, p)
    game_id = service.list_games(info["id"])["games"][0]["id"]

    with p.open("ab") as f:
        f.write(b"\n")
    os.utime(p)

    with pytest.raises(ServiceError, match="changed") as document_error:
        service.get_game_document(game_id)
    assert document_error.value.status == 409
    with pytest.raises(ServiceError, match="changed") as source_error:
        service.get_game_source(game_id)
    assert source_error.value.status == 409


def test_changed_source_during_replacement_keeps_previous_index_and_blocks_reads(
    service, fixture_copy, monkeypatch
):
    p = fixture_copy("basic_two_games.pgn")
    info = register_and_scan(service, p)
    before = service.list_games(info["id"])["games"]
    original_scan_pgn = service_module.scan_pgn

    def mutate_after_first_game(path, progress=None):
        games = original_scan_pgn(path, progress=progress)
        yield next(games)
        path.write_bytes(path.read_bytes() + b'\n[Event "Changed"]\n\n1. d4 *\n')
        yield from games

    monkeypatch.setattr(service_module, "scan_pgn", mutate_after_first_game)
    failed = service.scan_file_sync(info["id"], force=True)

    assert failed["scan_status"] == "error"
    assert "source changed during scan" in failed["scan_error"]
    after = service.list_games(info["id"])["games"]
    assert [(row["id"], row["idx_in_file"], row["event"], row["byte_size"]) for row in after] == [
        (row["id"], row["idx_in_file"], row["event"], row["byte_size"]) for row in before
    ]
    with pytest.raises(ServiceError, match="ready") as document_error:
        service.get_game_document(before[0]["id"])
    assert document_error.value.status == 409
    with pytest.raises(ServiceError, match="ready") as source_error:
        service.get_game_source(before[0]["id"])
    assert source_error.value.status == 409


def test_interrupted_scan_recovers_as_pending(db: Database, settings, fixture_copy):
    p = fixture_copy("basic_two_games.pgn")
    service = LibraryService(db, settings)
    info = service.register_file(p, scan=False)
    with db.connect() as connection:
        connection.execute("UPDATE files SET scan_status='scanning' WHERE id=?", (info["id"],))

    recovered = LibraryService(db, settings)
    pending = recovered.get_file(info["id"])

    assert pending["scan_status"] == "pending"
    assert pending["progress"] is None
    assert recovered.scan_file_sync(info["id"])["scan_status"] == "ready"


def test_list_games_filter_and_paging(service, large_pgn):
    info = register_and_scan(service, large_pgn)
    assert info["game_count"] == 5000
    page = service.list_games(info["id"], offset=0, limit=50)
    assert page["total"] == 5000 and len(page["games"]) == 50
    hit = service.list_games(info["id"], q="Player4321")
    assert hit["total"] == 1
    assert hit["games"][0]["white"] == "Player4321"


def test_get_game_document_by_offset(service, large_pgn):
    info = register_and_scan(service, large_pgn)
    target = service.list_games(info["id"], q="Player2500")["games"][0]
    doc = service.get_game_document(target["id"])
    assert dict(doc["headers"])["White"] == "Player2500"
    assert len(doc["nodes"]) == 11  # root + 10 plies
    assert doc["nodes"][1]["san"] == "e4"


def test_neighbors(service, fixture_copy):
    p = fixture_copy("basic_two_games.pgn")
    info = register_and_scan(service, p)
    games = service.list_games(info["id"])["games"]
    n0 = service.neighbor_game_ids(games[0]["id"])
    n1 = service.neighbor_game_ids(games[1]["id"])
    assert n0["prev"] is None and n0["next"] == games[1]["id"]
    assert n1["prev"] == games[0]["id"] and n1["next"] is None


def test_malformed_file_scan_records_index_warning(service, tmp_path):
    p = tmp_path / "tagless.pgn"
    p.write_text("1. e4 e5 *\n\n[Event \"OK\"]\n\n1. d4 *\n")
    info = register_and_scan(service, p)
    assert info["game_count"] == 2
    assert info["warning_count"] == 1
    games = service.list_games(info["id"])["games"]
    doc = service.get_game_document(games[0]["id"])
    assert any("index warning" in w for w in doc["warnings"])


def test_difficult_source_index_and_later_game_reads(service, tmp_path):
    corpus = json.loads((FIXTURES / "scan_corpus.json").read_text(encoding="utf-8"))
    case = next(case for case in corpus["cases"] if case["name"] == "difficult-source")
    p = tmp_path / "difficult-source.pgn"
    p.write_bytes(case["source"].encode("utf-8"))

    info = register_and_scan(service, p)
    assert info["game_count"] == 5
    assert info["warning_count"] == 1

    games = service.list_games(info["id"])["games"]
    assert [(game["idx_in_file"], game["event"], game["warning"]) for game in games] == [
        (0, "", "movetext with no tag section"),
        (1, "Duplicate final", None),
        (2, "Malformed middle", None),
        (3, "Headers only", None),
        (4, "After headers", None),
    ]

    malformed = service.get_game_document(games[2]["id"])
    assert malformed["warnings"]
    later = service.get_game_document(games[4]["id"])
    assert dict(later["headers"])["White"] == "Final game"
    expected = case["games"][4]
    expected_source = p.read_bytes()[expected["offsetStart"] : expected["offsetEnd"]].decode("utf-8")
    assert service.get_game_source(games[4]["id"]) == expected_source


def test_remove_file(service, fixture_copy):
    p = fixture_copy("basic_two_games.pgn")
    info = register_and_scan(service, p)
    assert service.list_games(info["id"])["total"] == 2
    service.remove_file(info["id"])
    assert p.exists(), "source file must never be deleted"
    with service.db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM games WHERE file_id=?", (info["id"],)).fetchone()[0] == 0
    with pytest.raises(NotFound):
        service.get_file(info["id"])


def test_reset_recreates_versioned_index_and_preserves_sources(service, fixture_copy):
    p = fixture_copy("basic_two_games.pgn")
    source_bytes = p.read_bytes()
    info = register_and_scan(service, p)
    assert service.list_games(info["id"])["total"] == 2

    service.reset_index()

    assert p.read_bytes() == source_bytes
    assert service.list_files() == []
    with service.db.connect() as conn:
        assert conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()["value"] == str(SCHEMA_VERSION)
        assert conn.execute("SELECT COUNT(*) FROM files").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM games").fetchone()[0] == 0


def test_remove_and_reset_reject_active_scans(service, fixture_copy):
    p = fixture_copy("basic_two_games.pgn")
    info = service.register_file(p, scan=False)
    with service.db.connect() as conn:
        conn.execute("UPDATE files SET scan_status='scanning' WHERE id=?", (info["id"],))
    with pytest.raises(ServiceError, match="cannot remove file while a scan is running"):
        service.remove_file(info["id"])
    with pytest.raises(ServiceError, match="cannot reset while a scan is running"):
        service.reset_index()


def test_missing_source_file_reported(service, fixture_copy):
    p = fixture_copy("basic_two_games.pgn")
    info = register_and_scan(service, p)
    games = service.list_games(info["id"])["games"]
    p.unlink()
    assert service.get_file(info["id"])["exists"] is False
    with pytest.raises(ServiceError):
        service.get_game_document(games[0]["id"])
