import { Chess } from "chess.js";
import { parse } from "chess.js/src/pgn.js";

import type { TagPair } from "./scanner.js";
import type { GameDocumentPayload, GameNode } from "./wire.js";

const HEADER_LINE_RE = /^[ \t]*\[[ \t]*([A-Za-z][A-Za-z0-9_]*)[ \t]+"((?:[^"\\]|\\.)*)"[ \t]*\][ \t]*(?:\r)?$/gm;
const RESULT_TOKENS = new Set(["1-0", "0-1", "1/2-1/2", "*"]);

export class HydrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HydrationError";
  }
}

type ParsedNode = {
  move?: string;
  suffix?: string[];
  nag?: string[];
  comment?: string;
  variations: ParsedNode[];
};

type ParsedGame = {
  root: ParsedNode;
};

type Arrow = {
  from: string;
  to: string;
  color: string;
};

type Highlight = {
  square: string;
  color: string;
};

type Annotations = {
  comment: string;
  arrows: Arrow[];
  highlights: Highlight[];
};

type TraversalFrame = {
  parsed: ParsedNode;
  documentId: number;
  nextChild: number;
  undoOnExit: boolean;
  startingComment: string;
};

const SUFFIX_NAGS: Record<string, number> = {
  "!": 1,
  "?": 2,
  "!!": 3,
  "??": 4,
  "!?": 5,
  "?!": 6,
};

const NAG_GLYPHS: Record<number, string> = {
  1: "!",
  2: "?",
  3: "!!",
  4: "??",
  5: "!?",
  6: "?!",
  7: "□",
  10: "=",
  11: "=",
  12: "=",
  13: "∞",
  14: "⩲",
  15: "⩱",
  16: "±",
  17: "∓",
  18: "+−",
  19: "−+",
  22: "⨀",
  23: "⨀",
  32: "⟳",
  33: "⟳",
  36: "↑",
  37: "↑",
  40: "→",
  41: "→",
  44: "=∞",
  45: "=∞",
  132: "⇆",
  133: "⇆",
  138: "⨁",
  139: "⨁",
  140: "∆",
  142: "⌓",
  146: "N",
};

const SHAPE_COLORS: Record<string, string> = {
  G: "green",
  R: "red",
  Y: "yellow",
  B: "blue",
};

const SHAPE_RE = /(\s?)\[%(?:csl|cal)\s([RGYB][a-h][1-8](?:[a-h][1-8])?(?:,[RGYB][a-h][1-8](?:[a-h][1-8])?)*)\](\s?)/g;
const TAG_LINE_RE = /^[ \t]*\[[ \t]*[A-Za-z][A-Za-z0-9_]*[ \t]+"(?:[^"\\]|\\.)*"[ \t]*\][ \t]*\r?$/;

/**
 * Hydrate one indexed PGN span into the flat document tree used on the wire.
 *
 * chess.js parses a RAV as a no-move wrapper whose first child is the
 * alternate continuation. Those wrappers are deliberately not represented in
 * the document: their children become siblings of the preceding move, with
 * the first child remaining the main continuation. The conversion uses one
 * mutable board and an explicit DFS stack so every node gets its position in
 * preorder without replaying a line from the root.
 */
export function hydrateGame(
  sourceBytes: Uint8Array,
  storedHeaders?: TagPair[],
  extraWarnings: string[] = [],
): GameDocumentPayload {
  const source = Buffer.from(sourceBytes).toString("utf8");
  const parseSource = source.startsWith("\ufeff") ? source.slice(1) : source;
  const headers = storedHeaders?.length ? copyHeaders(storedHeaders) : parseHeaders(parseSource);
  if (!source.trim()) throw new HydrationError("no PGN game found in source span");

  const warnings = [...extraWarnings];
  const board = startingBoard(headers, warnings);
  const nodes: GameNode[] = [rootNode(board)];
  let parsed: ParsedGame;
  try {
    parsed = parse(normalizeCommentsForParser(removeEscapeLines(parseSource))) as ParsedGame;
  } catch (error) {
    warnings.push(
      `could not parse PGN tree: ${error instanceof Error ? error.message : String(error)}`,
    );
    hydrateMainLine(board, nodes, removeHeaderLines(parseSource), warnings);
    return documentPayload(headers, nodes, warnings, source);
  }

  applyAnnotations(nodes[0], extractAnnotations(parsed.root.comment ?? ""));
  hydrateTree(board, nodes, parsed.root, warnings);
  return documentPayload(headers, nodes, warnings, source);
}

function documentPayload(
  headers: TagPair[],
  nodes: GameNode[],
  warnings: string[],
  source: string,
): GameDocumentPayload {
  return {
    headers,
    rootId: 0,
    nodes,
    result: headerValue(headers, "Result") ?? "*",
    warnings,
    source,
  };
}

function startingBoard(headers: TagPair[], warnings: string[]): Chess {
  const setup = headerValue(headers, "SetUp");
  const fen = headerValue(headers, "FEN");
  if (setup === "1" && fen) {
    try {
      return new Chess(fen);
    } catch (error) {
      warnings.push(
        `invalid FEN header, using standard start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return new Chess();
}

function hydrateTree(
  board: Chess,
  nodes: GameNode[],
  parsedRoot: ParsedNode,
  warnings: string[],
): void {
  const stack: TraversalFrame[] = [
    {
      parsed: parsedRoot,
      documentId: 0,
      nextChild: 0,
      undoOnExit: false,
      startingComment: "",
    },
  ];

  while (stack.length) {
    const frame = stack.at(-1)!;
    if (frame.nextChild >= frame.parsed.variations.length) {
      stack.pop();
      if (frame.undoOnExit) board.undo();
      continue;
    }

    const child = frame.parsed.variations[frame.nextChild++];
    if (!child.move) {
      // A RAV root has no move of its own. Its children are continuations
      // from the current position and must remain siblings of the main line.
      stack.push({
        parsed: child,
        documentId: frame.documentId,
        nextChild: 0,
        undoOnExit: false,
        startingComment: joinComments(frame.startingComment, child.comment),
      });
      continue;
    }

    const node = appendMove(
      board,
      nodes,
      frame.documentId,
      child.move,
      warnings,
      child,
      frame.startingComment,
    );
    if (!node) continue;
    stack.push({
      parsed: child,
      documentId: node.id,
      nextChild: 0,
      undoOnExit: true,
      startingComment: "",
    });
  }
}

function appendMove(
  board: Chess,
  nodes: GameNode[],
  parentId: number,
  token: string,
  warnings: string[],
  parsed?: ParsedNode,
  startingComment = "",
): GameNode | null {
  const color = board.turn();
  const moveNumber = board.moveNumber();
  let move;
  try {
    move = board.move(token, { strict: false });
  } catch (error) {
    warnings.push(
      `could not parse move ${token}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }

  const id = nodes.length;
  const annotations = extractAnnotations(parsed?.comment ?? "");
  const startingAnnotations = extractAnnotations(startingComment);
  const nags = parsed ? parsedNags(parsed) : [];
  const node: GameNode = {
    id,
    parentId,
    san: move.san,
    uci: `${move.from}${move.to}${move.promotion ?? ""}`,
    ply: positionPly(board),
    moveNumber,
    color,
    fen: board.fen(),
    nags,
    glyphs: nags.map((nag) => NAG_GLYPHS[nag] ?? `$${nag}`),
    comment: annotations.comment,
    startingComment: startingAnnotations.comment,
    children: [],
    arrows: [...annotations.arrows, ...startingAnnotations.arrows],
    highlights: [...annotations.highlights, ...startingAnnotations.highlights],
  };
  nodes[parentId].children.push(id);
  nodes.push(node);
  return node;
}

function applyAnnotations(node: GameNode, annotations: Annotations): void {
  node.comment = annotations.comment;
  node.arrows = annotations.arrows;
  node.highlights = annotations.highlights;
}

function parsedNags(parsed: ParsedNode): number[] {
  const numeric = (parsed.nag ?? [])
    .map((nag) => Number(nag))
    .filter((nag) => Number.isInteger(nag));
  const suffix = SUFFIX_NAGS[(parsed.suffix ?? []).join("")];
  if (suffix !== undefined) numeric.push(suffix);
  return numeric.sort((left, right) => left - right);
}

function extractAnnotations(comment: string): Annotations {
  const arrows: Arrow[] = [];
  const highlights: Highlight[] = [];
  const cleaned = comment.replace(
    SHAPE_RE,
    (_match: string, prefix: string, specs: string, suffix: string) => {
      for (const spec of specs.split(",")) {
        const color = SHAPE_COLORS[spec[0]];
        const from = spec.slice(1, 3);
        const to = spec.slice(3, 5);
        if (to.length === 2) {
          arrows.push({ from, to, color });
        } else {
          highlights.push({ square: from, color });
        }
      }
      return prefix || suffix ? " " : "";
    },
  ).trim();
  return { comment: cleaned, arrows, highlights };
}

function joinComments(first: string, second: string | undefined): string {
  if (!second) return first;
  return first ? `${first} ${second}` : second;
}

/**
 * chess.js accepts one comment at each parser position. PGN exports commonly
 * put adjacent comments before a variation move, so fold adjacent brace and
 * semicolon comments into one parser comment without changing the source sent
 * back to the client.
 */
function normalizeCommentsForParser(source: string): string {
  let result = "";
  let index = 0;

  while (index < source.length) {
    if (index === 0 || source[index - 1] === "\n") {
      const newline = source.indexOf("\n", index);
      const lineEnd = newline === -1 ? source.length : newline;
      const line = source.slice(index, lineEnd).replace(/\r$/, "");
      if (TAG_LINE_RE.test(line) || line.trimStart().startsWith("%")) {
        result += source.slice(index, lineEnd);
        index = lineEnd;
        continue;
      }
    }

    const marker = source[index];
    if (marker !== "{" && marker !== ";") {
      result += marker;
      index += 1;
      continue;
    }

    const comments: string[] = [];
    let cursor = index;
    while (cursor < source.length) {
      if (source[cursor] === "{") {
        const end = source.indexOf("}", cursor + 1);
        if (end === -1) {
          result += source.slice(index);
          return result;
        }
        comments.push(source.slice(cursor + 1, end));
        cursor = end + 1;
      } else if (source[cursor] === ";") {
        const newline = source.indexOf("\n", cursor + 1);
        const end = newline === -1 ? source.length : newline;
        comments.push(
          source
            .slice(cursor + 1, end)
            .replace(/\r$/, "")
            .replaceAll("{", "(")
            .replaceAll("}", ")")
            .trim(),
        );
        cursor = end;
      } else {
        break;
      }

      const whitespaceStart = cursor;
      while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
      if (source[cursor] !== "{" && source[cursor] !== ";") {
        cursor = whitespaceStart;
        break;
      }
    }

    result += `{${comments.join(" ")}}`;
    index = cursor;
  }

  return result;
}

function hydrateMainLine(
  board: Chess,
  nodes: GameNode[],
  source: string,
  warnings: string[],
): void {
  const tokens = tokenizeMainLine(source, warnings);
  for (const rawToken of tokens) {
    const token = normalizeMoveToken(rawToken);
    if (!token || isMoveNumber(token)) continue;
    if (RESULT_TOKENS.has(token)) break;
    if (token.startsWith("$")) continue;
    appendMove(board, nodes, nodes.length - 1, token, warnings);
  }
}

function rootNode(board: Chess): GameNode {
  return {
    id: 0,
    parentId: null,
    san: null,
    uci: null,
    ply: positionPly(board),
    moveNumber: board.moveNumber(),
    color: "",
    fen: board.fen(),
    nags: [],
    glyphs: [],
    comment: "",
    startingComment: "",
    children: [],
    arrows: [],
    highlights: [],
  };
}

function positionPly(board: Chess): number {
  return (board.moveNumber() - 1) * 2 + (board.turn() === "b" ? 1 : 0);
}

function parseHeaders(source: string): TagPair[] {
  return [...source.matchAll(HEADER_LINE_RE)].map((match) => [
    match[1],
    unescapeTagValue(match[2]),
  ]);
}

function copyHeaders(headers: TagPair[]): TagPair[] {
  return headers.map(([key, value]) => [key, value]);
}

function headerValue(headers: TagPair[], name: string): string | undefined {
  let value: string | undefined;
  for (const [key, candidate] of headers) {
    if (key === name) value = candidate;
  }
  return value;
}

function unescapeTagValue(value: string): string {
  return value.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

function removeHeaderLines(source: string): string {
  return source.replace(HEADER_LINE_RE, "");
}

function removeEscapeLines(source: string): string {
  let result = "";
  let lineStart = true;
  let inComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (lineStart && !inComment) {
      let marker = index;
      while (source[marker] === " " || source[marker] === "\t") marker += 1;
      if (source[marker] === "%") {
        const newline = source.indexOf("\n", marker);
        if (newline === -1) break;
        result += "\n";
        index = newline;
        lineStart = true;
        continue;
      }
    }

    result += character;
    if (character === "\n") {
      lineStart = true;
    } else if (character !== "\r") {
      lineStart = false;
    }
    if (!inComment && character === "{") inComment = true;
    else if (inComment && character === "}") inComment = false;
  }
  return result;
}

function tokenizeMainLine(source: string, warnings: string[]): string[] {
  const tokens: string[] = [];
  let token = "";
  let variationDepth = 0;
  let lineHasOnlyWhitespace = true;

  const flush = () => {
    if (token) tokens.push(token);
    token = "";
  };

  const skipBraceComment = (start: number): number => {
    const end = source.indexOf("}", start + 1);
    if (end === -1) {
      warnings.push("unterminated comment ignored while hydrating game");
      return source.length;
    }
    return end + 1;
  };

  let index = 0;
  while (index < source.length) {
    const character = source[index];

    if (variationDepth > 0) {
      if (character === "{") {
        index = skipBraceComment(index);
      } else if (character === "(") {
        variationDepth += 1;
        index += 1;
      } else if (character === ")") {
        variationDepth -= 1;
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }

    if (lineHasOnlyWhitespace && character === "%") {
      flush();
      const newline = source.indexOf("\n", index);
      index = newline === -1 ? source.length : newline + 1;
      lineHasOnlyWhitespace = true;
      continue;
    }
    if (character === "{") {
      flush();
      index = skipBraceComment(index);
      lineHasOnlyWhitespace = false;
      continue;
    }
    if (character === ";") {
      flush();
      const newline = source.indexOf("\n", index);
      index = newline === -1 ? source.length : newline + 1;
      lineHasOnlyWhitespace = true;
      continue;
    }
    if (character === "(") {
      flush();
      variationDepth = 1;
      index += 1;
      lineHasOnlyWhitespace = false;
      continue;
    }
    if (character === ")") {
      index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      lineHasOnlyWhitespace = character === "\n" || lineHasOnlyWhitespace;
      index += 1;
      continue;
    }

    token += character;
    lineHasOnlyWhitespace = false;
    index += 1;
  }

  flush();
  if (variationDepth > 0) warnings.push("unterminated variation ignored while hydrating game");
  return tokens;
}

function normalizeMoveToken(token: string): string {
  return token.replace(/^\d+\.{1,3}/, "").replace(/[!?]+$/, "");
}

function isMoveNumber(token: string): boolean {
  return /^\d+\.{1,3}$/.test(token) || /^\d+$/.test(token);
}
