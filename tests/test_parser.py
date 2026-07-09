"""Parser/document-model fidelity tests: comments, NAGs, RAVs, FEN, round-trip."""

from __future__ import annotations

import io

import chess.pgn
import pytest

from pgnreader.parser import GameParseError, hydrate_game
from pgnreader.scanner import read_game_bytes, scan_pgn

from .conftest import FIXTURES

MAX = 8 * 1024 * 1024


def hydrate_fixture(name: str, idx: int = 0):
    p = FIXTURES / name
    games = list(scan_pgn(p))
    data = read_game_bytes(p, games[idx].offset_start, games[idx].offset_end, MAX)
    return hydrate_game(data)


def mainline(doc):
    out, n = [], doc.nodes[0]
    while n.children:
        n = doc.nodes[n.children[0]]
        out.append(n)
    return out


def test_headers_preserved_in_order():
    doc = hydrate_fixture("basic_two_games.pgn")
    names = [k for k, _ in doc.headers]
    assert names[:7] == ["Event", "Site", "Date", "Round", "White", "Black", "Result"]
    assert dict(doc.headers)["ECO"] == "C50"


def test_brace_comments_and_pregame_comment():
    doc = hydrate_fixture("annotations.pgn")
    assert "Pre-game introduction comment." in doc.root.comment
    e4 = doc.nodes[doc.root.children[0]]
    assert e4.san == "e4"
    assert "Best by test." in e4.comment
    # multi-line comment content preserved (newlines normalized to space by parser)
    nc6 = next(n for n in doc.nodes if n.san == "Nc6")
    assert "spanning two lines" in doc.nodes[nc6.parent_id].comment


def test_semicolon_comment_preserved():
    doc = hydrate_fixture("annotations.pgn")
    nc6 = next(n for n in doc.nodes if n.san == "Nc6")
    assert "semicolon comment" in nc6.comment


def test_nags_suffix_and_numeric():
    doc = hydrate_fixture("annotations.pgn")
    by_san = {n.san: n for n in doc.nodes if n.san}
    assert 1 in by_san["e4"].nags            # !
    assert {6, 13} <= set(by_san["e5"].nags)  # ?! and $13
    assert {1, 14} <= set(by_san["Nf3"].nags)  # $1 $14
    assert 2 in by_san["a6"].nags            # ?
    assert 6 in by_san["Ba4"].nags           # ?!
    d = doc.to_dict()
    e4 = next(n for n in d["nodes"] if n["san"] == "e4")
    assert "!" in e4["glyphs"]


def test_variation_tree_structure():
    doc = hydrate_fixture("variations.pgn")
    nodes = doc.nodes
    e4 = nodes[doc.root.children[0]]
    e5 = nodes[e4.children[0]]
    assert e5.san == "e5"
    # e5 has two alternatives: 1...c5 and 1...e6
    assert len(e4.children) == 3
    c5 = nodes[e4.children[1]]
    e6 = nodes[e4.children[2]]
    assert c5.san == "c5" and "Sicilian" in c5.comment
    assert e6.san == "e6" and "French" in e6.comment
    assert "starting comment" in e6.starting_comment
    # nested: 2.Nf3 alt 2.c3 (Alapin), inside which 2...Nf6 alt 2...d5
    nf3 = nodes[c5.children[0]]
    assert nf3.san == "Nf3" and len(c5.children) == 2
    c3 = nodes[c5.children[1]]
    assert c3.san == "c3" and "Alapin" in c3.comment
    nf6 = nodes[c3.children[0]]
    assert nf6.san == "Nf6" and len(c3.children) == 2
    d5 = nodes[c3.children[1]]
    assert d5.san == "d5"
    # mainline unaffected by variations
    assert [n.san for n in mainline(doc)] == ["e4", "e5", "Nf3", "Nc6", "Bb5"]


def test_fen_setup_start_position():
    doc = hydrate_fixture("fen_start.pgn")
    assert doc.root.fen.startswith("1k6/1P3R2/8/8/8/8/r7/2K5 w")
    first = doc.nodes[doc.root.children[0]]
    assert first.san == "Rf8+"
    assert first.move_number == 1 and first.color == "w"


def test_invalid_fen_degrades_with_warning():
    src = b'[Event "Bad"]\n[FEN "totally invalid"]\n\n1. e4 *\n'
    doc = hydrate_game(src)
    assert any("invalid FEN" in w.lower() or "invalid fen" in w.lower() for w in doc.warnings)
    assert doc.root.fen.startswith("rnbqkbnr/")


def test_malformed_movetext_keeps_prefix_and_warns():
    doc = hydrate_fixture("malformed_middle.pgn", idx=1)
    assert doc.warnings, "expected parser warnings for broken SAN"
    sans = [n.san for n in mainline(doc)]
    assert sans[:2] == ["e4", "e5"]  # legal prefix survives


def test_headers_only_game_hydrates_empty_tree():
    doc = hydrate_fixture("headers_only.pgn", idx=0)
    assert doc.root.children == []
    assert dict(doc.headers)["White"] == "NoMoves"


def test_unparseable_span_raises():
    with pytest.raises(GameParseError):
        hydrate_game(b"")


def test_source_round_trip_is_exact():
    p = FIXTURES / "variations.pgn"
    g = list(scan_pgn(p))[0]
    data = read_game_bytes(p, g.offset_start, g.offset_end, MAX)
    doc = hydrate_game(data)
    assert doc.source == data.decode("utf-8")
    original = p.read_text(encoding="utf-8")
    assert doc.source in original  # byte-exact slice of the file


def test_normalized_reexport_preserves_tree():
    """Exporting via python-chess and re-hydrating yields an identical tree."""
    doc = hydrate_fixture("variations.pgn")
    game = chess.pgn.read_game(io.StringIO(doc.source))
    exporter = chess.pgn.StringExporter(headers=True, variations=True, comments=True)
    normalized = game.accept(exporter)
    doc2 = hydrate_game(normalized.encode())

    def shape(d):
        return [(n.san, tuple(n.nags), len(n.children)) for n in d.nodes]

    assert shape(doc) == shape(doc2)


def test_cal_csl_shapes_extracted():
    doc = hydrate_fixture("graphics.pgn")
    root = doc.root
    # root: [%csl Gd4,Re5] [%cal Gd2d4]
    assert root.highlights == [
        {"square": "d4", "color": "green"},
        {"square": "e5", "color": "red"},
    ]
    assert root.arrows == [{"from": "d2", "to": "d4", "color": "green"}]
    assert "[%" not in root.comment and "Intro with shapes." in root.comment

    by_san = {n.san: n for n in doc.nodes if n.san}
    e4 = by_san["e4"]
    assert {"from": "e2", "to": "e4", "color": "green"} in e4.arrows
    assert {"from": "d7", "to": "d5", "color": "red"} in e4.arrows
    assert e4.highlights == [{"square": "e4", "color": "yellow"}]
    assert "King's pawn." in e4.comment and "[%" not in e4.comment

    c5 = by_san["c5"]
    assert c5.highlights == [{"square": "c5", "color": "blue"}]
    assert c5.comment == ""  # comment was only the shape tag

    # shapes in a starting comment attach to the node (pre-move approximation)
    c3 = by_san["c3"]
    assert {"from": "g1", "to": "f3", "color": "yellow"} in c3.arrows
    assert "pre-move shapes" in c3.starting_comment
    assert "[%" not in c3.starting_comment

    # nodes without shape tags stay clean (mainline Nf3, not the one in the
    # c5 variation, which shadows it in by_san)
    main_nf3 = mainline(doc)[2]
    assert main_nf3.san == "Nf3"
    assert main_nf3.arrows == [] and main_nf3.highlights == []
    assert main_nf3.comment == "no shapes here"

    # no false unrecognized-token warnings from the bracket tags
    assert doc.warnings == []

    # serialization carries the shapes
    d = doc.to_dict()
    root_d = d["nodes"][0]
    assert root_d["arrows"] and root_d["highlights"]


def test_shapes_source_round_trip_untouched():
    """Extraction must not affect the raw source slice."""
    p = FIXTURES / "graphics.pgn"
    g = list(scan_pgn(p))[0]
    data = read_game_bytes(p, g.offset_start, g.offset_end, MAX)
    doc = hydrate_game(data)
    assert "[%cal Ge2e4,Rd7d5]" in doc.source
    assert "[%csl Gd4,Re5]" in doc.source


def test_very_long_movetext(long_movetext_pgn):
    games = list(scan_pgn(long_movetext_pgn))
    assert len(games) == 1
    data = read_game_bytes(long_movetext_pgn, games[0].offset_start, games[0].offset_end, MAX)
    doc = hydrate_game(data)
    assert len(doc.nodes) == 1001  # root + 500 full moves (1000 plies)
    assert doc.nodes[-1].ply == 1000
    d = doc.to_dict()  # flat serialization must not recurse
    assert len(d["nodes"]) == 1001
