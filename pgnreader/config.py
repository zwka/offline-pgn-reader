"""Application settings.

Everything is overridable via PGNREADER_* environment variables so the app
stays configurable without a config-file format. All paths are resolved
relative to the project root (the directory containing this package) unless
given as absolute paths.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _env_path(name: str, default: Path) -> Path:
    raw = os.environ.get(name)
    if not raw:
        return default
    p = Path(raw).expanduser()
    return p if p.is_absolute() else PROJECT_ROOT / p


def _env_paths(name: str, default: list[Path]) -> list[Path]:
    raw = os.environ.get(name)
    if not raw:
        return default
    out = []
    for part in raw.split(os.pathsep):
        part = part.strip()
        if part:
            p = Path(part).expanduser()
            out.append(p if p.is_absolute() else PROJECT_ROOT / p)
    return out


@dataclass(frozen=True)
class Settings:
    host: str = os.environ.get("PGNREADER_HOST", "127.0.0.1")
    port: int = int(os.environ.get("PGNREADER_PORT", "8642"))
    debug: bool = os.environ.get("PGNREADER_DEBUG", "").lower() in ("1", "true", "yes")

    data_dir: Path = _env_path("PGNREADER_DATA_DIR", PROJECT_ROOT / "data")
    # Directories offered by the "discover" endpoint for one-click registration.
    watch_dirs: list[Path] = field(
        default_factory=lambda: _env_paths(
            "PGNREADER_WATCH_DIRS",
            [PROJECT_ROOT / "samples", PROJECT_ROOT / "library"],
        )
    )
    # Uploaded files are copied here so they live inside the project folder.
    upload_dir: Path = _env_path("PGNREADER_UPLOAD_DIR", PROJECT_ROOT / "library")

    # Hard cap on a single game's byte span during hydration; a span larger
    # than this indicates a scanner problem or a pathological file.
    max_game_bytes: int = int(os.environ.get("PGNREADER_MAX_GAME_BYTES", str(8 * 1024 * 1024)))

    @property
    def db_path(self) -> Path:
        return self.data_dir / "index.sqlite3"

    @property
    def log_path(self) -> Path:
        return self.data_dir / "pgnreader.log"

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.upload_dir.mkdir(parents=True, exist_ok=True)


settings = Settings()
