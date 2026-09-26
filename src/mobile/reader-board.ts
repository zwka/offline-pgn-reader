import type { GameNode } from "../wire.js";

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const SHAPE_VARIABLES: Record<string, string> = {
  green: "--shape-green",
  red: "--shape-red",
  yellow: "--shape-yellow",
  blue: "--shape-blue",
};

function shapeColor(name: string): string {
  return `var(${SHAPE_VARIABLES[name] || SHAPE_VARIABLES.green})`;
}

export type MobileBoard = {
  container: HTMLElement;
  squares: Map<string, HTMLElement>;
  flipped: boolean;
};

export function createBoard(container: HTMLElement): MobileBoard {
  container.classList.add("board");
  return { container, squares: new Map(), flipped: false };
}

export function renderBoard(
  board: MobileBoard,
  fen: string,
  lastUci: string | null,
  node: GameNode,
): void {
  const { container, squares } = board;
  container.replaceChildren();
  squares.clear();

  const placement = (fen || "8/8/8/8/8/8/8/8 w - - 0 1").split(" ")[0];
  const grid = parsePlacement(placement);
  const lastMoveSquares = new Set<string>();
  if (lastUci && lastUci.length >= 4) {
    lastMoveSquares.add(lastUci.slice(0, 2));
    lastMoveSquares.add(lastUci.slice(2, 4));
  }
  const tints = new Map<string, string>();
  for (const highlight of node.highlights) {
    tints.set(highlight.square, shapeColor(highlight.color));
  }

  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const rank = board.flipped ? row + 1 : 8 - row;
      const fileIndex = board.flipped ? 7 - col : col;
      const name = FILES[fileIndex] + rank;
      const square = document.createElement("div");
      square.className = `sq ${(rank + fileIndex) % 2 === 1 ? "light" : "dark"}`;
      square.dataset.square = name;

      if (lastMoveSquares.has(name) && !tints.has(name)) square.classList.add("hl");
      const tintColor = tints.get(name);
      if (tintColor) {
        const tint = document.createElement("div");
        tint.className = "csl";
        tint.style.background = tintColor;
        square.appendChild(tint);
      }

      const piece = grid[8 - rank][fileIndex];
      if (piece) {
        const image = document.createElement("img");
        image.className = "piece";
        image.src = pieceUrl(piece);
        image.alt = piece;
        image.draggable = false;
        square.appendChild(image);
      }
      if (row === 7) square.appendChild(coordinate(FILES[fileIndex], "file"));
      if (col === 0) square.appendChild(coordinate(String(rank), "rank"));

      squares.set(name, square);
      container.appendChild(square);
    }
  }

  if (node.arrows.length > 0) container.appendChild(buildArrowLayer(node.arrows, board.flipped));
}

function pieceUrl(fenChar: string): string {
  const color = fenChar === fenChar.toUpperCase() ? "w" : "b";
  return new URL(`../../pieces/${color}${fenChar.toUpperCase()}.svg`, import.meta.url).href;
}

function coordinate(value: string, kind: "file" | "rank"): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = `coord ${kind}`;
  element.textContent = value;
  return element;
}

function buildArrowLayer(
  arrows: GameNode["arrows"],
  flipped: boolean,
): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "board-arrows");
  svg.setAttribute("viewBox", "0 0 8 8");

  for (const arrow of arrows) {
    const from = squareXY(arrow.from, flipped);
    const to = squareXY(arrow.to, flipped);
    const x1 = from.x + 0.5;
    const y1 = from.y + 0.5;
    const x2 = to.x + 0.5;
    const y2 = to.y + 0.5;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy);
    if (!length) continue;

    const ux = dx / length;
    const uy = dy / length;
    const px = -uy;
    const py = ux;
    const headLength = 0.42;
    const headWidth = 0.24;
    const margin = 0.2;
    const shaftWidth = 0.16;
    const startX = x1 + ux * margin;
    const startY = y1 + uy * margin;
    const tipX = x2 - ux * 0.06;
    const tipY = y2 - uy * 0.06;
    const baseX = tipX - ux * headLength;
    const baseY = tipY - uy * headLength;
    const color = shapeColor(arrow.color);

    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("fill", color);
    group.setAttribute("stroke", color);
    group.setAttribute("opacity", "0.75");

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", startX.toFixed(3));
    line.setAttribute("y1", startY.toFixed(3));
    line.setAttribute("x2", baseX.toFixed(3));
    line.setAttribute("y2", baseY.toFixed(3));
    line.setAttribute("stroke-width", String(shaftWidth));
    line.setAttribute("stroke-linecap", "round");
    group.appendChild(line);

    const head = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    head.setAttribute(
      "points",
      `${tipX.toFixed(3)},${tipY.toFixed(3)} ` +
        `${(baseX + px * headWidth).toFixed(3)},${(baseY + py * headWidth).toFixed(3)} ` +
        `${(baseX - px * headWidth).toFixed(3)},${(baseY - py * headWidth).toFixed(3)}`,
    );
    head.setAttribute("stroke", "none");
    group.appendChild(head);
    svg.appendChild(group);
  }

  return svg;
}

function squareXY(name: string, flipped: boolean): { x: number; y: number } {
  const fileIndex = name.charCodeAt(0) - 97;
  const rank = Number(name[1]);
  return {
    x: flipped ? 7 - fileIndex : fileIndex,
    y: flipped ? rank - 1 : 8 - rank,
  };
}

function parsePlacement(placement: string): Array<Array<string | null>> {
  const grid: Array<Array<string | null>> = [];
  for (const rank of placement.split("/")) {
    const row: Array<string | null> = [];
    for (const character of rank) {
      if (/\d/.test(character)) {
        for (let index = 0; index < Number(character); index += 1) row.push(null);
      } else {
        row.push(character);
      }
    }
    while (row.length < 8) row.push(null);
    grid.push(row);
  }
  while (grid.length < 8) grid.push(new Array(8).fill(null));
  return grid;
}
