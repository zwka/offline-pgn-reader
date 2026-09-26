// Chess board rendering from FEN. Read-only display: no move input needed.
// Pieces are the CBurnett SVG set (Lichess default), vendored locally in
// /static/pieces so the app stays fully offline.

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

// Theme-aware brush palette for [%cal]/[%csl] graphics annotations.
const SHAPE_VARIABLES = {
  green: "--shape-green",
  red: "--shape-red",
  yellow: "--shape-yellow",
  blue: "--shape-blue",
};

function shapeColor(name) {
  return `var(${SHAPE_VARIABLES[name] || SHAPE_VARIABLES.green})`;
}

function pieceUrl(fenChar) {
  const color = fenChar === fenChar.toUpperCase() ? "w" : "b";
  return `/static/pieces/${color}${fenChar.toUpperCase()}.svg`;
}

/** Square name -> board-grid coordinates (col, row) honoring orientation. */
function squareXY(name, flipped) {
  const fileIdx = name.charCodeAt(0) - 97;
  const rank = +name[1];
  return {
    x: flipped ? 7 - fileIdx : fileIdx,
    y: flipped ? rank - 1 : 8 - rank,
  };
}

export function createBoard(container) {
  container.classList.add("board");
  const squares = new Map(); // "e4" -> element
  return { container, squares, flipped: false };
}

/**
 * Render `fen` onto the board; `lastUci` highlights the last move's squares.
 * `shapes` carries [%cal]/[%csl] annotations:
 *   { arrows: [{from,to,color}], highlights: [{square,color}] }
 */
export function renderBoard(board, fen, lastUci = null, shapes = null) {
  const { container, squares } = board;
  container.textContent = "";
  squares.clear();

  const placement = (fen || "8/8/8/8/8/8/8/8 w - - 0 1").split(" ")[0];
  const grid = parsePlacement(placement);
  const hl = new Set();
  if (lastUci && lastUci.length >= 4) {
    hl.add(lastUci.slice(0, 2));
    hl.add(lastUci.slice(2, 4));
  }
  const tints = new Map(); // square name -> css color
  for (const h of shapes?.highlights || []) {
    tints.set(h.square, shapeColor(h.color));
  }

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const rank = board.flipped ? row + 1 : 8 - row;
      const fileIdx = board.flipped ? 7 - col : col;
      const name = FILES[fileIdx] + rank;
      const sq = document.createElement("div");
      sq.className = `sq ${(rank + fileIdx) % 2 === 1 ? "light" : "dark"}`;
      sq.dataset.square = name;
      // A [%csl] tint is an author annotation; it outranks the default
      // last-move highlight on the same square.
      if (hl.has(name) && !tints.has(name)) sq.classList.add("hl");
      if (tints.has(name)) {
        const tint = document.createElement("div");
        tint.className = "csl";
        tint.style.background = tints.get(name);
        sq.appendChild(tint);
      }

      const piece = grid[8 - rank][fileIdx];
      if (piece) {
        const el = document.createElement("img");
        el.className = "piece";
        el.src = pieceUrl(piece);
        el.alt = piece;
        el.draggable = false;
        sq.appendChild(el);
      }
      if (row === 7) sq.insertAdjacentHTML("beforeend", `<span class="coord file">${FILES[fileIdx]}</span>`);
      if (col === 0) sq.insertAdjacentHTML("beforeend", `<span class="coord rank">${rank}</span>`);

      squares.set(name, sq);
      container.appendChild(sq);
    }
  }

  const arrows = shapes?.arrows || [];
  if (arrows.length) container.appendChild(buildArrowLayer(arrows, board.flipped));
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** SVG overlay drawing [%cal] arrows in an 8×8 unit coordinate space. */
function buildArrowLayer(arrows, flipped) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "board-arrows");
  svg.setAttribute("viewBox", "0 0 8 8");

  for (const a of arrows) {
    const from = squareXY(a.from, flipped);
    const to = squareXY(a.to, flipped);
    const x1 = from.x + 0.5, y1 = from.y + 0.5;
    const x2 = to.x + 0.5, y2 = to.y + 0.5;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (!len) continue;
    const ux = dx / len, uy = dy / len;   // unit direction
    const px = -uy, py = ux;              // unit perpendicular

    // Shaft starts off-center and stops where the arrowhead begins.
    const headLen = 0.42, headWidth = 0.24, margin = 0.2, shaftW = 0.16;
    const sx = x1 + ux * margin, sy = y1 + uy * margin;
    const tipX = x2 - ux * 0.06, tipY = y2 - uy * 0.06;
    const baseX = tipX - ux * headLen, baseY = tipY - uy * headLen;
    const color = shapeColor(a.color);

    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("fill", color);
    g.setAttribute("stroke", color);
    g.setAttribute("opacity", "0.75");

    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", sx.toFixed(3));
    line.setAttribute("y1", sy.toFixed(3));
    line.setAttribute("x2", baseX.toFixed(3));
    line.setAttribute("y2", baseY.toFixed(3));
    line.setAttribute("stroke-width", shaftW);
    line.setAttribute("stroke-linecap", "round");
    g.appendChild(line);

    const head = document.createElementNS(SVG_NS, "polygon");
    head.setAttribute(
      "points",
      `${tipX.toFixed(3)},${tipY.toFixed(3)} ` +
        `${(baseX + px * headWidth).toFixed(3)},${(baseY + py * headWidth).toFixed(3)} ` +
        `${(baseX - px * headWidth).toFixed(3)},${(baseY - py * headWidth).toFixed(3)}`
    );
    head.setAttribute("stroke", "none");
    g.appendChild(head);
    svg.appendChild(g);
  }
  return svg;
}

function parsePlacement(placement) {
  const grid = [];
  for (const rankStr of placement.split("/")) {
    const row = [];
    for (const ch of rankStr) {
      if (/\d/.test(ch)) for (let i = 0; i < +ch; i++) row.push(null);
      else row.push(ch);
    }
    while (row.length < 8) row.push(null);
    grid.push(row);
  }
  while (grid.length < 8) grid.push(new Array(8).fill(null));
  return grid;
}
