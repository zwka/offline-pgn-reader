import { Chess } from "chess.js";
import { parse } from "chess.js/src/pgn.js";

import type { TagPair } from "./scanner.js";
import type { GameDocumentPayload, GameNode } from "./wire.js";

const HEADER_LINE_RE = /^[ \t]*\[[ \t]*([A-Za-z][A-Za-z0-9_]*)[ \t]+"((?:[^"\\]|\\.)*)"[ \t]*\][ \t]*(?:\r)?$/gm;
const RESULT_TOKENS = new Set(["1-0", "0-1", "1/2-1/2", "*"]);
const NULL_MOVE_TOKEN = "null";

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

type RecoveryItem =
  | { kind: "comment"; text: string }
  | { kind: "token"; text: string };

type RecoveryToken =
  | { kind: "move"; token: string; suffix: string[]; nag: string[] }
  | { kind: "nag"; nags: number[] }
  | { kind: "result" }
  | { kind: "skip" };

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
    parsed = parse(adaptParserSource(parseSource)) as ParsedGame;
  } catch (error) {
    warnings.push(
      `could not parse PGN tree: ${error instanceof Error ? error.message : String(error)}`,
    );
    hydrateMainLine(board, nodes, parseSource, warnings);
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
  const nullMove = token === NULL_MOVE_TOKEN;
  let move;
  try {
    move = board.move(nullMove ? "--" : token, { strict: false });
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
    san: nullMove ? "--" : move.san,
    uci: nullMove ? "0000" : `${move.from}${move.to}${move.promotion ?? ""}`,
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

function appendComment(node: GameNode, comment: string): void {
  const annotations = extractAnnotations(joinComments(node.comment, comment));
  node.comment = annotations.comment;
  node.arrows.push(...annotations.arrows);
  node.highlights.push(...annotations.highlights);
}

function appendNags(node: GameNode, nags: number[]): void {
  node.nags.push(...nags);
  node.nags.sort((left, right) => left - right);
  node.glyphs = node.nags.map((nag) => NAG_GLYPHS[nag] ?? `$${nag}`);
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
  const cleaned = comment.replace(/[\r\n]+/g, " ").replace(
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

function adaptParserSource(source: string): string {
  const commentsNormalized = normalizeCommentsForParser(removeEscapeLines(source));
  const variationCommentsMoved = relocatePostVariationComments(commentsNormalized);
  return replaceNullMoves(normalizeCommentsForParser(variationCommentsMoved));
}

type RewrittenSequence = {
  text: string;
  index: number;
  closed: boolean;
};

/**
 * chess.js rejects comments after a completed RAV, although those comments
 * are legal PGN and belong to the move before the variation. Move such
 * comments before the consecutive variation block in parser-only text.
 */
function relocatePostVariationComments(source: string): string {
  return rewriteParserSequence(source, 0, false).text;
}

function rewriteParserSequence(
  source: string,
  start: number,
  inVariation: boolean,
): RewrittenSequence {
  let index = start;
  let text = "";

  while (index < source.length) {
    const character = source[index];
    if (inVariation && character === ")") {
      return { text, index: index + 1, closed: true };
    }

    const tagEnd = tagLineEnd(source, index);
    if (tagEnd !== null) {
      text += source.slice(index, tagEnd);
      index = tagEnd;
      continue;
    }

    if (character === "{") {
      const end = source.indexOf("}", index + 1);
      if (end === -1) {
        return { text: text + source.slice(index), index: source.length, closed: false };
      }
      text += source.slice(index, end + 1);
      index = end + 1;
      continue;
    }

    if (character === "(") {
      const block = rewriteVariationBlock(source, index);
      text += block.text;
      index = block.index;
      continue;
    }

    text += character;
    index += 1;
  }

  return { text, index, closed: false };
}

function rewriteVariationBlock(source: string, start: number): RewrittenSequence {
  const groups: string[] = [];
  const movedComments: string[] = [];
  let index = start;
  let trailingWhitespace = "";

  while (index < source.length && source[index] === "(") {
    const inner = rewriteParserSequence(source, index + 1, true);
    groups.push(`(${inner.text}${inner.closed ? ")" : ""}`);
    index = inner.index;

    const whitespaceStart = index;
    while (index < source.length && /\s/.test(source[index])) index += 1;
    let gap = source.slice(whitespaceStart, index);

    while (index < source.length && source[index] === "{") {
      const end = source.indexOf("}", index + 1);
      if (end === -1) {
        movedComments.push(source.slice(index));
        index = source.length;
        gap = "";
        break;
      }
      movedComments.push(source.slice(index, end + 1));
      index = end + 1;
      const afterComment = index;
      while (index < source.length && /\s/.test(source[index])) index += 1;
      gap = source.slice(afterComment, index);
    }

    trailingWhitespace = gap;
    if (source[index] !== "(") break;
  }

  const groupText = groups.join(" ");
  if (movedComments.length === 0) {
    return { text: groupText + trailingWhitespace, index, closed: true };
  }
  return {
    text: `${movedComments.join(" ")} ${groupText}${trailingWhitespace}`,
    index,
    closed: true,
  };
}

function replaceNullMoves(source: string): string {
  let result = "";
  let index = 0;

  while (index < source.length) {
    const tagEnd = tagLineEnd(source, index);
    if (tagEnd !== null) {
      result += source.slice(index, tagEnd);
      index = tagEnd;
      continue;
    }

    const character = source[index];
    if (character === "{") {
      const end = source.indexOf("}", index + 1);
      if (end === -1) return result + source.slice(index);
      result += source.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (/\s/.test(character) || character === "(" || character === ")") {
      result += character;
      index += 1;
      continue;
    }

    const start = index;
    while (
      index < source.length &&
      !/\s/.test(source[index]) &&
      source[index] !== "{" &&
      source[index] !== "}" &&
      source[index] !== "(" &&
      source[index] !== ")"
    ) {
      index += 1;
    }
    result += normalizeNullMoveToken(source.slice(start, index));
  }

  return result;
}

function normalizeNullMoveToken(token: string): string {
  const match = /^(\d+\.{1,3})?(Z0|--|null)([!?]*)$/.exec(token);
  return match ? `${match[1] ?? ""}${NULL_MOVE_TOKEN}${match[3]}` : token;
}

function tagLineEnd(source: string, index: number): number | null {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  if (source.slice(lineStart, index).trim().length > 0) return null;
  const newline = source.indexOf("\n", index);
  const lineEnd = newline === -1 ? source.length : newline;
  const line = source.slice(lineStart, lineEnd).replace(/\r$/, "");
  return TAG_LINE_RE.test(line) ? lineEnd : null;
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
  for (const item of tokenizeMainLine(source, warnings)) {
    if (item.kind === "comment") {
      appendComment(nodes.at(-1)!, item.text);
      continue;
    }

    const parsed = parseRecoveryToken(item.text);
    if (parsed.kind === "result") break;
    if (parsed.kind === "nag") {
      if (nodes.length > 1) appendNags(nodes.at(-1)!, parsed.nags);
      continue;
    }
    if (parsed.kind !== "move") continue;

    appendMove(board, nodes, nodes.length - 1, parsed.token, warnings, {
      move: parsed.token,
      suffix: parsed.suffix,
      nag: parsed.nag,
      variations: [],
    });
  }
}

function parseRecoveryToken(rawToken: string): RecoveryToken {
  let token = rawToken.replace(/^\d+\.{1,3}/, "");
  if (!token || isMoveNumber(token)) return { kind: "skip" };
  if (RESULT_TOKENS.has(token)) return { kind: "result" };

  if (/^\$\d+(?:\$\d+)*$/.test(token)) {
    const nags = [...token.matchAll(/\$(\d+)/g)]
      .map((match) => Number(match[1]))
      .filter((nag) => Number.isInteger(nag));
    return { kind: "nag", nags };
  }

  const suffixMatch = /([!?]{1,2})$/.exec(token);
  const suffix = suffixMatch ? [suffixMatch[1]] : [];
  if (suffixMatch) token = token.slice(0, -suffixMatch[1].length);
  if (!token) {
    const nag = SUFFIX_NAGS[suffix[0]];
    return nag === undefined ? { kind: "skip" } : { kind: "nag", nags: [nag] };
  }

  return {
    kind: "move",
    token: normalizeNullMoveToken(token),
    suffix,
    nag: [],
  };
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

function tokenizeMainLine(source: string, warnings: string[]): RecoveryItem[] {
  const items: RecoveryItem[] = [];
  let token = "";
  let variationDepth = 0;
  let lineHasOnlyWhitespace = true;

  const flush = () => {
    if (token) items.push({ kind: "token", text: token });
    token = "";
  };

  const skipBraceComment = (start: number, keep: boolean): number => {
    const end = source.indexOf("}", start + 1);
    if (end === -1) {
      warnings.push("unterminated comment ignored while hydrating game");
      if (keep) items.push({ kind: "comment", text: source.slice(start + 1) });
      return source.length;
    }
    if (keep) items.push({ kind: "comment", text: source.slice(start + 1, end) });
    return end + 1;
  };

  const skipLine = (start: number): number => {
    const newline = source.indexOf("\n", start);
    return newline === -1 ? source.length : newline + 1;
  };

  const lineStateAt = (position: number): boolean => {
    const lineStart = source.lastIndexOf("\n", position - 1) + 1;
    return source.slice(lineStart, position).trim().length === 0;
  };

  let index = 0;
  while (index < source.length) {
    const character = source[index];

    if (variationDepth > 0) {
      if (character === "{") {
        index = skipBraceComment(index, false);
      } else if (character === ";") {
        index = skipLine(index);
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

    if (lineHasOnlyWhitespace) {
      const tagEnd = tagLineEnd(source, index);
      if (tagEnd !== null) {
        flush();
        index = tagEnd;
        continue;
      }
    }
    if (lineHasOnlyWhitespace && character === "%") {
      flush();
      index = skipLine(index);
      lineHasOnlyWhitespace = true;
      continue;
    }
    if (character === "{") {
      flush();
      index = skipBraceComment(index, true);
      lineHasOnlyWhitespace = lineStateAt(index);
      continue;
    }
    if (character === ";") {
      flush();
      const newline = source.indexOf("\n", index + 1);
      const end = newline === -1 ? source.length : newline;
      items.push({
        kind: "comment",
        text: source
          .slice(index + 1, end)
          .replace(/\r$/, "")
          .replaceAll("{", "(")
          .replaceAll("}", ")")
          .trim(),
      });
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
  return items;
}

function isMoveNumber(token: string): boolean {
  return /^\d+\.{1,3}$/.test(token) || /^\d+$/.test(token);
}
