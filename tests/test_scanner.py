"""Scanner unit tests: boundaries, offsets, malformed input, fingerprints."""

from __future__ import annotations

import os
import time
import json

from pgnreader.scanner import fingerprint_file, read_game_bytes, scan_pgn

from .conftest import FIXTURES

MAX = 8 * 1024 * 1024


def scan(path):
    return list(scan_pgn(path))


def test_two_games_boundaries_and_headers(fixture_copy):
    p = fixture_copy("basic_two_games.pgn")
    games = scan(p)
    assert len(games) == 2
    assert games[0].header("White") == "Alpha, A."
    assert games[0].header("ECO") == "C50"
    assert games[1].header("Round") == "2"
    assert games[0].idx_in_file == 0 and games[1].idx_in_file == 1


def test_shared_scan_contract_matches_the_python_oracle():
    contract = json.loads((FIXTURES / "scan_contract.json").read_text(encoding="utf-8"))
    games = scan(FIXTURES / contract["source"])

    assert len(games) == len(contract["games"])
    for actual, expected in zip(games, contract["games"]):
        assert actual.idx_in_file == expected["idxInFile"]
        assert actual.offset_start == expected["offsetStart"]
        assert actual.offset_end == expected["offsetEnd"]
        assert actual.headers == [tuple(pair) for pair in expected["headers"]]
        assert actual.warning == expected["warning"]


def test_offsets_reread_exact_spans(fixture_copy):
    p = fixture_copy("basic_two_games.pgn")
    games = scan(p)
    for g in games:
        data = read_game_bytes(p, g.offset_start, g.offset_end, MAX)
        text = data.decode()
        assert text.startswith('[Event "')
        # Span must contain this game's players and not the other game's result
        assert g.header("White") in text
    g0, g1 = games
    assert g0.offset_end <= g1.offset_start
    first = read_game_bytes(p, g0.offset_start, g0.offset_end, MAX).decode()
    assert "1-0" in first and "1/2-1/2" not in first


def test_multiline_comment_with_fake_tag_is_not_a_boundary():
    games = scan(FIXTURES / "comment_trap.pgn")
    assert len(games) == 2
    assert games[0].header("Event") == "Trap A"
    assert games[1].header("Event") == "Trap B"
    # the fake tag stays inside game 0's span
    text = read_game_bytes(
        FIXTURES / "comment_trap.pgn", games[0].offset_start, games[0].offset_end, MAX
    ).decode()
    assert "NOT A REAL GAME" in text


def test_headers_only_game_detected():
    games = scan(FIXTURES / "headers_only.pgn")
    assert len(games) == 2
    assert games[0].header("White") == "NoMoves"
    assert games[1].header("White") == "Has"


def test_escape_lines_ignored():
    games = scan(FIXTURES / "escape_lines.pgn")
    assert len(games) == 1
    assert games[0].header("Event") == "Escaped"


def test_crlf_and_bom(crlf_bom_pgn):
    games = scan(crlf_bom_pgn)
    assert len(games) == 2
    assert games[0].header("Event") == "BOM Game"
    data = read_game_bytes(crlf_bom_pgn, games[0].offset_start, games[0].offset_end, MAX)
    assert "déjà" in data.decode("utf-8")


def test_malformed_game_does_not_break_neighbors():
    games = scan(FIXTURES / "malformed_middle.pgn")
    assert len(games) == 3
    assert [g.header("Event") for g in games] == ["Good One", "Broken", "Good Two"]


def test_movetext_without_tags_flagged(tmp_path):
    p = tmp_path / "tagless.pgn"
    p.write_text("1. e4 e5 2. Nf3 *\n\n[Event \"Tagged\"]\n\n1. d4 *\n")
    games = scan(p)
    assert len(games) == 2
    assert games[0].warning == "movetext with no tag section"
    assert games[1].header("Event") == "Tagged"


def test_semicolon_comment_with_brace_does_not_open_comment(tmp_path):
    p = tmp_path / "semi.pgn"
    p.write_text(
        '[Event "Semi"]\n\n1. e4 e5 ; comment with { unbalanced brace\n'
        '2. Nf3 *\n\n[Event "Next"]\n\n1. d4 *\n'
    )
    games = scan(p)
    assert len(games) == 2  # the '{' in the ; comment must not swallow game 2


def test_progress_callback(large_pgn):
    calls = []
    list(scan_pgn(large_pgn, progress=lambda d, t, g: calls.append((d, t, g)), progress_every_bytes=64 * 1024))
    assert calls, "expected progress callbacks"
    done, total, games = calls[-1]
    assert done == total and games == 5000


def test_fingerprint_changes_on_modification(fixture_copy):
    p = fixture_copy("basic_two_games.pgn")
    fp1 = fingerprint_file(p)
    assert fp1 == fingerprint_file(p)
    time.sleep(0.01)
    with p.open("a") as f:
        f.write("\n")
    os.utime(p)  # ensure mtime moves even on coarse filesystems
    assert fingerprint_file(p) != fp1
