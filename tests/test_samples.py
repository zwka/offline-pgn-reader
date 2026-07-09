"""Regression tests against the real sample PGNs in samples/.

These are first-class fixtures: exact game counts, annotation fidelity spot
checks against known content, and a full-file hydration sweep. Skipped
automatically when samples/ is empty.
"""

from __future__ import annotations

import time

import pytest

from pgnreader.parser import hydrate_game
from pgnreader.scanner import read_game_bytes, scan_pgn

from .conftest import SAMPLES, requires_samples

MAX = 8 * 1024 * 1024

BANZEA = SAMPLES / "Alex Banzea - The Caro-Kann Simplified.pgn"
KABADAYI = SAMPLES / "Can Kabadayi - Fundamental Chess Calculation Skills.pgn"

EXPECTED_COUNTS = {BANZEA: 185, KABADAYI: 351}

pytestmark = requires_samples


def known_samples():
    return [p for p in EXPECTED_COUNTS if p.is_file()]


@pytest.mark.parametrize("path", known_samples(), ids=lambda p: p.stem[:24])
def test_exact_game_counts(path):
    games = list(scan_pgn(path))
    assert len(games) == EXPECTED_COUNTS[path]
    assert all(g.warning is None for g in games)


@pytest.mark.parametrize("path", known_samples(), ids=lambda p: p.stem[:24])
def test_full_hydration_sweep(path):
    """Every indexed span parses; annotation structures come through."""
    t0 = time.perf_counter()
    total_nodes = total_warnings = 0
    for g in scan_pgn(path):
        doc = hydrate_game(read_game_bytes(path, g.offset_start, g.offset_end, MAX))
        total_nodes += len(doc.nodes)
        total_warnings += len(doc.warnings)
        # every game in these exports declares a FEN start
        assert doc.root.fen
    assert total_warnings == 0
    assert total_nodes > 1000
    assert time.perf_counter() - t0 < 30


@pytest.mark.skipif(not KABADAYI.is_file(), reason="Kabadayi sample missing")
def test_kabadayi_annotation_fidelity():
    """Spot-check a known game: '8. Attack — Pawn Storm' (RAVs, NAGs, starting comment)."""
    games = list(scan_pgn(KABADAYI))
    target = next(
        g for g in games if g.header("White") == "8. Attack" and g.header("Black") == "Pawn Storm"
    )
    doc = hydrate_game(read_game_bytes(KABADAYI, target.offset_start, target.offset_end, MAX))
    # known structure: first move g5 has two alternatives (17.h4 $6 and a
    # duplicate 17.g5 leaf carrying a starting comment "h5")
    root = doc.root
    assert len(root.children) == 3
    first_alts = [doc.nodes[i] for i in root.children]
    assert [n.san for n in first_alts] == ["g5", "h4", "g5"]
    assert 6 in first_alts[1].nags  # ?!
    assert first_alts[2].starting_comment == "h5"
    assert "keeps it closed too" in first_alts[2].comment
    # FEN start: game begins at move 17 with White to move
    assert first_alts[0].move_number == 17 and first_alts[0].color == "w"
    # pre-game prose comes through on the root
    assert "Korchnoi - Karpov" in root.comment


@pytest.mark.skipif(not BANZEA.is_file(), reason="Banzea sample missing")
def test_banzea_intro_prose_preserved():
    games = list(scan_pgn(BANZEA))
    intro = games[0]
    assert intro.header("White") == "Introduction"
    doc = hydrate_game(read_game_bytes(BANZEA, intro.offset_start, intro.offset_end, MAX))
    joined = " ".join(n.comment for n in doc.nodes)
    assert "Caro-Kann project" in joined
    # nonstandard black move numbering ('1. c6') parses as 1...c6
    c6 = next(n for n in doc.nodes if n.san == "c6")
    assert c6.color == "b" and c6.move_number == 1


@pytest.mark.parametrize("path", known_samples(), ids=lambda p: p.stem[:24])
def test_samples_source_round_trip(path):
    """Raw span extraction reproduces the original file bytes exactly."""
    games = list(scan_pgn(path))
    raw = path.read_bytes()
    for g in (games[0], games[len(games) // 2], games[-1]):
        span = raw[g.offset_start:g.offset_end]
        assert span == read_game_bytes(path, g.offset_start, g.offset_end, MAX) or span.startswith(
            b"\xef\xbb\xbf"
        )
