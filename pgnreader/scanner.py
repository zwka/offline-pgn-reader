"""Streaming PGN boundary scanner.

Finds game boundaries and extracts tag-pair headers from arbitrarily large PGN
files in a single pass, WITHOUT parsing movetext. Memory use is O(one game's
tag section). Byte offsets are exact (binary line iteration with manual
accounting), so any game can later be re-read with a single seek.

Correctness notes:

* Brace comments may span lines and may contain '[' at line start; the scanner
  tracks brace state across lines so such lines are never mistaken for tag
  pairs. Per the PGN spec, brace comments do not nest.
* ';' starts a rest-of-line comment (no cross-line state). '%' at column 0
  (outside a brace comment) is an escape line and is ignored.
* A UTF-8 BOM on the first line is tolerated; offsets remain raw byte offsets.
* Malformed material degrades to per-game warnings, never a failed scan:
  movetext with no preceding tag section becomes a headerless game record.
"""

from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterator

log = logging.getLogger("pgnreader.scanner")

TAG_RE = re.compile(r'^\s*\[\s*([A-Za-z][A-Za-z0-9_]*)\s+"((?:[^"\\]|\\.)*)"\s*\]\s*$')
_BOM = b"\xef\xbb\xbf"

ProgressFn = Callable[[int, int, int], None]  # bytes_done, bytes_total, games_found


@dataclass
class ScannedGame:
    idx_in_file: int
    offset_start: int
    offset_end: int  # exclusive; end of the game's last content line
    headers: list[tuple[str, str]] = field(default_factory=list)
    warning: str | None = None

    def header(self, name: str, default: str = "") -> str:
        for k, v in self.headers:
            if k == name:
                return v
        return default


def _unescape_tag_value(raw: str) -> str:
    return raw.replace('\\"', '"').replace("\\\\", "\\")


def _scan_movetext_line(line: str, in_comment: bool) -> bool:
    """Update cross-line brace-comment state for one movetext line."""
    # Fast paths: no state-changing characters on this line at all.
    if in_comment:
        if "}" not in line:
            return True
    elif "{" not in line and ";" not in line:
        return False
    for ch in line:
        if in_comment:
            if ch == "}":
                in_comment = False
        elif ch == "{":
            in_comment = True
        elif ch == ";":
            break  # rest of line is a comment
    return in_comment


def scan_pgn(
    path: Path,
    progress: ProgressFn | None = None,
    progress_every_bytes: int = 4 * 1024 * 1024,
) -> Iterator[ScannedGame]:
    """Yield one ScannedGame per game found in *path*, in file order."""
    size = path.stat().st_size
    offset = 0
    next_progress = progress_every_bytes

    current: ScannedGame | None = None
    has_movetext = False
    blank_after_tags = False
    in_comment = False
    content_end = 0  # end offset of last non-blank line of current game
    games_found = 0

    def close_current() -> ScannedGame | None:
        nonlocal current
        if current is None:
            return None
        current.offset_end = content_end
        done, current = current, None
        return done

    with path.open("rb") as f:
        first_line = True
        for raw in f:
            line_start = offset
            offset += len(raw)

            stripped_raw = raw
            if first_line:
                first_line = False
                if stripped_raw.startswith(_BOM):
                    stripped_raw = stripped_raw[len(_BOM):]

            text = stripped_raw.decode("utf-8", errors="replace").rstrip("\r\n")
            blank = not text.strip()

            if progress is not None and offset >= next_progress:
                next_progress = offset + progress_every_bytes
                progress(offset, size, games_found)

            if blank:
                if current is not None and current.headers and not has_movetext:
                    blank_after_tags = True
                continue

            tag_match = None if in_comment else TAG_RE.match(text)

            if tag_match:
                name = tag_match.group(1)
                value = _unescape_tag_value(tag_match.group(2))
                # Boundary: a tag line after movetext always starts a new game.
                # A tag section restarting after a blank line (headers-only
                # game, common in malformed exports) is detected via 'Event'.
                if current is not None and (
                    has_movetext or (blank_after_tags and name == "Event")
                ):
                    done = close_current()
                    if done is not None:
                        games_found += 1
                        yield done
                if current is None:
                    current = ScannedGame(
                        idx_in_file=games_found, offset_start=line_start, offset_end=line_start
                    )
                    has_movetext = False
                    blank_after_tags = False
                    in_comment = False
                elif has_movetext:  # unreachable safety net
                    pass
                current.headers.append((name, value))
                content_end = offset - _trailing_newline_len(raw)
                continue

            # Escape line: only meaningful at column 0 outside a comment.
            if not in_comment and raw.startswith(b"%"):
                continue

            # Movetext (or garbage) line.
            if current is None:
                current = ScannedGame(
                    idx_in_file=games_found,
                    offset_start=line_start,
                    offset_end=line_start,
                    warning="movetext with no tag section",
                )
                blank_after_tags = False
            has_movetext = True
            in_comment = _scan_movetext_line(text, in_comment)
            content_end = offset - _trailing_newline_len(raw)

    done = close_current()
    if done is not None:
        games_found += 1
        yield done

    if progress is not None:
        progress(size, size, games_found)


def _trailing_newline_len(raw: bytes) -> int:
    if raw.endswith(b"\r\n"):
        return 2
    if raw.endswith(b"\n") or raw.endswith(b"\r"):
        return 1
    return 0


def read_game_bytes(path: Path, offset_start: int, offset_end: int, max_bytes: int) -> bytes:
    """Read one game's exact source span with a single seek."""
    length = offset_end - offset_start
    if length < 0 or length > max_bytes:
        raise ValueError(f"invalid game span: {offset_start}..{offset_end} (max {max_bytes})")
    with path.open("rb") as f:
        f.seek(offset_start)
        data = f.read(length)
    return data


def fingerprint_file(path: Path, sample_bytes: int = 65536) -> str:
    """Cheap change-detection fingerprint: size + mtime + head/tail digest."""
    st = path.stat()
    h = hashlib.sha1()
    h.update(f"{st.st_size}:{st.st_mtime_ns}:".encode())
    with path.open("rb") as f:
        h.update(f.read(sample_bytes))
        if st.st_size > sample_bytes * 2:
            f.seek(-sample_bytes, 2)
            h.update(f.read(sample_bytes))
    return h.hexdigest()
