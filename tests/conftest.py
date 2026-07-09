from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from pgnreader.config import PROJECT_ROOT, Settings
from pgnreader.db import Database
from pgnreader.service import LibraryService

FIXTURES = Path(__file__).parent / "fixtures"
SAMPLES = PROJECT_ROOT / "samples"


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        data_dir=tmp_path / "data",
        watch_dirs=[tmp_path / "watch"],
        upload_dir=tmp_path / "library",
    )


@pytest.fixture
def db(settings: Settings) -> Database:
    settings.ensure_dirs()
    database = Database(settings.db_path)
    database.initialize()
    return database


@pytest.fixture
def service(db: Database, settings: Settings) -> LibraryService:
    return LibraryService(db, settings)


@pytest.fixture
def fixture_copy(tmp_path: Path):
    """Copy a named fixture into tmp so tests can mutate it safely."""

    def _copy(name: str) -> Path:
        dest = tmp_path / name
        shutil.copy(FIXTURES / name, dest)
        return dest

    return _copy


@pytest.fixture
def crlf_bom_pgn(tmp_path: Path) -> Path:
    """A PGN with UTF-8 BOM and CRLF line endings (as seen in Chessable exports)."""
    text = (
        '[Event "BOM Game"]\r\n[Site "?"]\r\n[Date "????.??.??"]\r\n[Round "?"]\r\n'
        '[White "Bom"]\r\n[Black "Crlf"]\r\n[Result "*"]\r\n\r\n'
        "1. e4 e5 2. Nf3 {comment with unicode: ♞ and déjà vu} *\r\n\r\n"
        '[Event "Second"]\r\n[Site "?"]\r\n[Date "????.??.??"]\r\n[Round "?"]\r\n'
        '[White "Two"]\r\n[Black "Crlf"]\r\n[Result "*"]\r\n\r\n1. d4 *\r\n'
    )
    p = tmp_path / "crlf_bom.pgn"
    p.write_bytes(b"\xef\xbb\xbf" + text.encode("utf-8"))
    return p


@pytest.fixture
def large_pgn(tmp_path: Path) -> Path:
    """Synthetic many-game file for indexing behavior tests (5,000 games)."""
    game = (
        '[Event "Bulk {i}"]\n[Site "Gen"]\n[Date "2024.01.01"]\n[Round "{i}"]\n'
        '[White "Player{i}"]\n[Black "Opponent{i}"]\n[Result "1-0"]\n\n'
        "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 1-0\n\n"
    )
    p = tmp_path / "large.pgn"
    with p.open("w", encoding="utf-8") as f:
        for i in range(5000):
            f.write(game.replace("{i}", str(i)))
    return p


@pytest.fixture
def long_movetext_pgn(tmp_path: Path) -> Path:
    """A single game with a very long mainline (shuffle kings ~ 2,000 plies)."""
    moves = []
    seq = ["Nf3", "Nf6", "Ng1", "Ng8"]  # repetition is legal PGN, fine for parsing
    for i in range(500):
        w = seq[(2 * i) % 4]
        b = seq[(2 * i + 1) % 4]
        moves.append(f"{i + 1}. {w} {b}")
    body = " ".join(moves) + " *"
    p = tmp_path / "long.pgn"
    p.write_text(
        '[Event "Marathon"]\n[Site "?"]\n[Date "????.??.??"]\n[Round "?"]\n'
        '[White "Long"]\n[Black "Game"]\n[Result "*"]\n\n' + body + "\n",
        encoding="utf-8",
    )
    return p


def sample_files() -> list[Path]:
    if not SAMPLES.is_dir():
        return []
    return sorted(SAMPLES.glob("*.pgn"))


requires_samples = pytest.mark.skipif(
    not sample_files(), reason="no sample PGNs present in samples/"
)
