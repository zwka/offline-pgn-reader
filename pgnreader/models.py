"""Typed document model for parsed games.

The move tree is explicit: every node lists its children, children[0] being
the main continuation and the rest sidelines, exactly as ordered in the
source. For transport the tree is flattened into an id-addressed array —
this avoids deep JSON recursion on very long mainlines and gives the UI O(1)
node lookup — but parent/child ids preserve the full tree structure.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# Numeric Annotation Glyph -> display glyph. Unknown NAGs render as "$n"
# (kept, never dropped). Covers the move-assessment and common positional set.
NAG_GLYPHS: dict[int, str] = {
    1: "!", 2: "?", 3: "!!", 4: "??", 5: "!?", 6: "?!", 7: "□",
    10: "=", 11: "=", 12: "=", 13: "∞",
    14: "⩲", 15: "⩱", 16: "±", 17: "∓", 18: "+−", 19: "−+",
    22: "⨀", 23: "⨀",
    32: "⟳", 33: "⟳", 36: "↑", 37: "↑", 40: "→", 41: "→",
    44: "=∞", 45: "=∞", 132: "⇆", 133: "⇆", 138: "⨁", 139: "⨁",
    140: "∆", 142: "⌓", 146: "N",
}


def nag_glyph(nag: int) -> str:
    return NAG_GLYPHS.get(nag, f"${nag}")


@dataclass
class MoveNode:
    id: int
    parent_id: int | None
    san: str | None          # None only on the root node
    uci: str | None
    ply: int                 # plies from the starting position (root = start ply)
    move_number: int
    color: str               # 'w' | 'b' ('' on root)
    fen: str                 # position AFTER this move (root: starting position)
    nags: list[int] = field(default_factory=list)
    comment: str = ""
    starting_comment: str = ""
    children: list[int] = field(default_factory=list)
    # Graphics annotations extracted from [%cal]/[%csl] comment tags.
    # arrows: {"from": "d2", "to": "d4", "color": "green"}
    # highlights: {"square": "e5", "color": "red"}
    arrows: list[dict] = field(default_factory=list)
    highlights: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "parentId": self.parent_id,
            "san": self.san,
            "uci": self.uci,
            "ply": self.ply,
            "moveNumber": self.move_number,
            "color": self.color,
            "fen": self.fen,
            "nags": self.nags,
            "glyphs": [nag_glyph(n) for n in self.nags],
            "comment": self.comment,
            "startingComment": self.starting_comment,
            "children": self.children,
            "arrows": self.arrows,
            "highlights": self.highlights,
        }


@dataclass
class GameDocument:
    headers: list[tuple[str, str]]     # source order preserved
    nodes: list[MoveNode]              # nodes[0] is the root; ids == list index
    result: str
    warnings: list[str] = field(default_factory=list)
    source: str = ""                   # exact original PGN slice (decoded)

    @property
    def root(self) -> MoveNode:
        return self.nodes[0]

    def to_dict(self) -> dict[str, Any]:
        return {
            "headers": [[k, v] for k, v in self.headers],
            "nodes": [n.to_dict() for n in self.nodes],
            "rootId": 0,
            "result": self.result,
            "warnings": self.warnings,
            "source": self.source,
        }
