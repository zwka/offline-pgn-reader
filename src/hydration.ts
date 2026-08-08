import { Chess } from "chess.js";

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

/**
 * Hydrate the root and main continuation of one indexed PGN span.
 *
 * The document deliberately stays flat on the wire. Variations and
 * annotations are parsed by later tickets; comments and side-lines are
 * skipped here so a normal main line remains readable without losing its
 * source span.
 */
export function hydrateGame(
  sourceBytes: Uint8Array,
  storedHeaders?: TagPair[],
): GameDocumentPayload {
  const source = Buffer.from(sourceBytes).toString("utf8");
  const parseSource = source.startsWith("\ufeff") ? source.slice(1) : source;
  const headers = storedHeaders?.length ? copyHeaders(storedHeaders) : parseHeaders(parseSource);
  if (!source.trim()) throw new HydrationError("no PGN game found in source span");

  const warnings: string[] = [];
  const board = new Chess();
  const nodes: GameNode[] = [rootNode(board)];
  const tokens = tokenizeMainLine(removeHeaderLines(parseSource), warnings);

  for (const rawToken of tokens) {
    const token = normalizeMoveToken(rawToken);
    if (!token || isMoveNumber(token)) continue;
    if (RESULT_TOKENS.has(token)) break;
    if (token.startsWith("$")) continue;

    const parentId = nodes.length - 1;
    const color = board.turn();
    const moveNumber = board.moveNumber();
    let move;
    try {
      move = board.move(token, { strict: false });
    } catch (error) {
      warnings.push(
        `could not parse move ${rawToken}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    const id = nodes.length;
    const node: GameNode = {
      id,
      parentId,
      san: move.san,
      uci: `${move.from}${move.to}${move.promotion ?? ""}`,
      ply: positionPly(board),
      moveNumber,
      color,
      fen: board.fen(),
      nags: [],
      glyphs: [],
      comment: "",
      startingComment: "",
      children: [],
      arrows: [],
      highlights: [],
    };
    nodes[parentId].children.push(id);
    nodes.push(node);
  }

  return {
    headers,
    rootId: 0,
    nodes,
    result: headerValue(headers, "Result") ?? "*",
    warnings,
    source,
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

function removeHeaderLines(source: string): string {
  return source.replace(HEADER_LINE_RE, "");
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
