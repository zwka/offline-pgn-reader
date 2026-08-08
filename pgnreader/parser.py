"""Game hydration: raw PGN bytes -> GameDocument.

Uses python-chess for movetext parsing (SAN, RAVs, NAGs, comments,
FEN/SetUp starting positions) and converts its recursive game tree into the
flat, id-addressed document model.

Performance: the conversion walks the tree with ONE incrementally
pushed/popped board, so building N nodes costs O(N) — never
``node.board()``, which replays from the root per node (O(N²)).
Traversal uses an explicit stack, so variation nesting depth cannot hit
Python's recursion limit.
"""

from __future__ import annotations

import io
import logging
import re

import chess
import chess.pgn

from .models import GameDocument, MoveNode
from .scanner import TAG_RE

log = logging.getLogger("pgnreader.parser")


class GameParseError(Exception):
    """The byte span could not be parsed as a PGN game at all."""


def hydrate_game(
    source_bytes: bytes,
    extra_warnings: list[str] | None = None,
    stored_headers: list[tuple[str, str]] | None = None,
) -> GameDocument:
    source = source_bytes.decode("utf-8", errors="replace")
    # Keep the decoded source exact, but do not let a UTF-8 BOM become movetext.
    parse_text, _ = _promote_semicolon_comments(source.removeprefix("\ufeff"))
    game = chess.pgn.read_game(io.StringIO(parse_text))
    if game is None:
        raise GameParseError("no PGN game found in source span")

    warnings = list(extra_warnings or [])
    warnings.extend(_format_error(e) for e in game.errors)
    warnings.extend(_find_unrecognized_tokens(parse_text))

    try:
        root_board = game.board()  # honors FEN/SetUp/Variant headers
    except ValueError as exc:
        # Invalid FEN header: degrade to standard start, keep the evidence.
        warnings.append(f"invalid FEN header, using standard start: {exc}")
        root_board = chess.Board()

    root_comment, root_arrows, root_highlights = _extract_shapes(_comment_text(game.comment))
    nodes: list[MoveNode] = [
        MoveNode(
            id=0,
            parent_id=None,
            san=None,
            uci=None,
            ply=root_board.ply(),
            move_number=root_board.fullmove_number,
            color="",
            fen=root_board.fen(),
            comment=root_comment,
            children=[],
            arrows=root_arrows,
            highlights=root_highlights,
        )
    ]

    # Iterative DFS. Each frame is (chess_node, doc_id, child_iterator).
    # The shared board always holds the position of the frame being expanded;
    # we push a move when descending and pop when a frame is exhausted.
    board = root_board
    stack: list[tuple[chess.pgn.GameNode, int, int]] = [(game, 0, 0)]
    while stack:
        cnode, doc_id, child_idx = stack[-1]
        if child_idx >= len(cnode.variations):
            stack.pop()
            if stack:
                board.pop()
            continue
        stack[-1] = (cnode, doc_id, child_idx + 1)

        child = cnode.variations[child_idx]
        move = child.move
        try:
            san = board.san(move)
        except (ValueError, AssertionError) as exc:  # illegal move slipped through
            warnings.append(f"skipped illegal move {move} after node {doc_id}: {exc}")
            continue
        move_number = board.fullmove_number
        color = "w" if board.turn == chess.WHITE else "b"
        board.push(move)

        comment, arrows, highlights = _extract_shapes(_comment_text(child.comment))
        # Shapes in a starting comment technically describe the pre-move
        # position; we attach them to this node (shown with its position) as
        # a pragmatic approximation rather than dropping them.
        starting_comment, s_arrows, s_highlights = _extract_shapes(
            _comment_text(child.starting_comment)
        )
        node = MoveNode(
            id=len(nodes),
            parent_id=doc_id,
            san=san,
            uci=move.uci(),
            ply=board.ply(),
            move_number=move_number,
            color=color,
            fen=board.fen(),
            nags=sorted(child.nags),
            comment=comment,
            starting_comment=starting_comment,
            arrows=arrows + s_arrows,
            highlights=highlights + s_highlights,
        )
        nodes.append(node)
        nodes[doc_id].children.append(node.id)
        stack.append((child, node.id, 0))

    headers = stored_headers if stored_headers is not None else list(game.headers.items())
    return GameDocument(
        headers=headers,
        nodes=nodes,
        result=game.headers.get("Result", "*"),
        warnings=warnings,
        source=source,
    )


# Recognized movetext tokens, mirroring python-chess's MOVETEXT_REGEX plus
# move numbers, dots, results and structural characters. Anything in movetext
# (outside comments) not covered by this is silently dropped by python-chess,
# so we surface it as a warning instead of losing it without a trace.
_TOKEN_RE = re.compile(
    r"""
    [NBKRQ]?[a-h]?[1-8]?[\-x]?[a-h][1-8](?:=?[nbrqkNBRQK])?[+#]?[!?]{0,2}
    |[PNBRQK]?@[a-h][1-8][+#]?
    |--|Z0|0000|@@@@
    |O-O(?:-O)?[+#]?[!?]{0,2}|0-0(?:-0)?[+#]?
    |1-0|0-1|1/2-1/2|\*
    |\$\d+
    |[?!]{1,2}
    |\d+\.*
    |[().]
    """,
    re.VERBOSE,
)


def _promote_semicolon_comments(source: str) -> tuple[str, int]:
    """Convert ';' rest-of-line comments into brace comments.

    python-chess discards ';' comments entirely; converting them to '{...}'
    before parsing preserves them in the document model. The original source
    string is never modified — only the text handed to the parser.
    """
    if ";" not in source:
        return source, 0
    out: list[str] = []
    in_comment = False
    count = 0
    for line in source.splitlines(keepends=True):
        if not in_comment and TAG_RE.match(line.rstrip("\r\n")):
            out.append(line)
            continue
        if not in_comment and line.startswith("%"):
            out.append(line)
            continue
        buf: list[str] = []
        i = 0
        while i < len(line):
            ch = line[i]
            if in_comment:
                buf.append(ch)
                if ch == "}":
                    in_comment = False
            elif ch == "{":
                buf.append(ch)
                in_comment = True
            elif ch == ";":
                rest = line[i + 1:].rstrip("\r\n")
                # Braces inside the promoted comment would corrupt nesting.
                rest = rest.replace("{", "(").replace("}", ")").strip()
                nl = line[len(line.rstrip("\r\n")):]
                if rest:
                    buf.append("{ " + rest + " }")
                    count += 1
                buf.append(nl)
                i = len(line)
                break
            else:
                buf.append(ch)
            i += 1
        out.append("".join(buf))
    return "".join(out), count


def _find_unrecognized_tokens(source: str, max_reported: int = 5) -> list[str]:
    """Report movetext tokens python-chess would silently skip."""
    bad: list[str] = []
    in_comment = False
    seen_moves = False
    for line in source.splitlines():
        if not in_comment:
            if TAG_RE.match(line) and not seen_moves:
                continue
            if line.startswith("%"):
                continue
        seen_moves = True
        i = 0
        while i < len(line):
            if in_comment:
                end = line.find("}", i)
                if end == -1:
                    i = len(line)
                else:
                    in_comment = False
                    i = end + 1
                continue
            ch = line[i]
            if ch == "{":
                in_comment = True
                i += 1
                continue
            if ch.isspace():
                i += 1
                continue
            m = _TOKEN_RE.match(line, i)
            if m and m.end() > i:
                i = m.end()
                continue
            # unrecognized run up to next whitespace/brace
            j = i
            while j < len(line) and not line[j].isspace() and line[j] not in "{}":
                j += 1
            tok = line[i:j]
            if len(bad) < max_reported:
                bad.append(f"unrecognized movetext token dropped by parser: {tok!r}")
            elif len(bad) == max_reported:
                bad.append("further unrecognized tokens omitted")
                return bad
            i = j
    return bad


_SHAPE_COLORS = {"G": "green", "R": "red", "Y": "yellow", "B": "blue"}


def _extract_shapes(comment: str) -> tuple[str, list[dict], list[dict]]:
    """Pull [%cal]/[%csl] graphics annotations out of a comment.

    Returns (cleaned_comment, arrows, highlights). The annotations are
    removed from the display text — they are rendered on the board instead.
    The original PGN source is never modified.
    """
    if "[%" not in comment:
        return comment, [], []
    arrows: list[dict] = []
    highlights: list[dict] = []

    for m in chess.pgn.ARROWS_REGEX.finditer(comment):
        for spec in m.group("arrows").split(","):
            color = _SHAPE_COLORS[spec[0]]
            tail, head = spec[1:3], spec[3:5]
            if head:
                arrows.append({"from": tail, "to": head, "color": color})
            else:
                highlights.append({"square": tail, "color": color})

    def collapse(m: re.Match) -> str:
        return " " if (m.group("prefix") or m.group("suffix")) else ""

    cleaned = chess.pgn.ARROWS_REGEX.sub(collapse, comment).strip()
    return cleaned, arrows, highlights


def _comment_text(comment: object) -> str:
    """python-chess >=1.11 may expose comments as a list of strings."""
    if isinstance(comment, list):
        text = "\n\n".join(str(c) for c in comment)
    else:
        text = str(comment or "")
    # Keep the wire representation stable with the chess.js parser used by Node.
    return re.sub(r"[\r\n]+", " ", text)


def _format_error(err: Exception) -> str:
    return f"{type(err).__name__}: {err}"
