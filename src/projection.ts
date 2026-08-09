import { Value } from "@sinclair/typebox/value";

import { hydrateGame, HydrationError } from "./hydration.js";
import type {
  Index,
  IndexFile,
  IndexGame,
  IndexGamePage,
  IndexGameRow,
  NeighborGameIds,
} from "./index.js";
import {
  readSourceSpan,
  sourceFingerprint,
  sourceStats,
  SourceChangedError,
  SourceMissingError,
  SourceSpanError,
} from "./source.js";
import {
  ErrorResponseSchema,
  type ErrorResponse,
  type FileRecord,
  type GameDocument,
  type GameDocumentPayload,
  type GamePage,
  type GameRecord,
  type TagPair,
  type TagPairs,
} from "./wire.js";

const DEFAULT_MAX_GAME_BYTES = 8 * 1024 * 1024;

export type ProjectionProgress = {
  bytesDone: number;
  bytesTotal: number;
  gamesFound: number;
};

export type ReaderProjectionOptions = {
  maxGameBytes?: number;
  progress?: (fileId: number) => ProjectionProgress | null;
};

export type ProjectedError = {
  statusCode: number;
  body: ErrorResponse;
};

export class ServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export class NotFound extends ServiceError {
  constructor(message: string) {
    super(message, 404);
    this.name = "NotFound";
  }
}

/**
 * Owns the boundary between persisted Index data, hydrated documents, and
 * the responses consumed by the CLI, HTTP adapter, and browser.
 */
export class ReaderProjection {
  private readonly maxGameBytes: number;
  private readonly progress: (fileId: number) => ProjectionProgress | null;

  constructor(
    private readonly index: Index,
    options: ReaderProjectionOptions = {},
  ) {
    this.maxGameBytes = options.maxGameBytes ?? DEFAULT_MAX_GAME_BYTES;
    this.progress = options.progress ?? (() => null);
  }

  listFiles(): FileRecord[] {
    return this.index.listFiles().map((row) => projectFileRow(row, this.progress(row.id)));
  }

  getFile(fileId: number): FileRecord {
    const row = this.index.getFile(fileId);
    if (!row) throw new NotFound(`file ${fileId} not found`);
    return projectFileRow(row, this.progress(row.id));
  }

  listGames(fileId: number, query = "", offset = 0, limit = 100): GamePage {
    this.getFile(fileId);
    return projectGamePage(this.index.listGames(fileId, query, offset, limit));
  }

  getGameDocument(gameId: number): GameDocument {
    const row = this.gameRowById(gameId);
    const source = this.readGameBytes(row);
    const extraWarnings = row.warning ? [`index warning: ${row.warning}`] : [];
    let hydrated: GameDocumentPayload;
    try {
      hydrated = hydrateGame(source, decodeTagPairs(row.tag_json), extraWarnings);
    } catch (error) {
      if (error instanceof HydrationError) {
        throw new ServiceError(`game could not be parsed: ${error.message}`, 422);
      }
      throw error;
    }
    return projectGameDocument(row, hydrated, this.neighborsFor(row));
  }

  getGameSource(gameId: number): string {
    const row = this.gameRowById(gameId);
    return this.readGameBytes(row).toString("utf8");
  }

  getGameTags(gameId: number): TagPairs {
    return decodeTagPairs(this.gameRowById(gameId).tag_json);
  }

  neighborGameIds(gameId: number): NeighborGameIds {
    return this.neighborsFor(this.gameRowById(gameId));
  }

  private gameRowById(gameId: number): IndexGame {
    const row = this.index.getGame(gameId);
    if (!row) throw new NotFound(`game ${gameId} not found`);
    return row;
  }

  private neighborsFor(row: IndexGame): NeighborGameIds {
    const neighbors = this.index.neighborGameIds(row.id);
    if (!neighbors) throw new NotFound(`game ${row.id} not found`);
    return projectNeighbors(neighbors);
  }

  private readGameBytes(row: IndexGame): Buffer {
    if (row.file_scan_status !== "ready") {
      throw new ServiceError(
        `source index is not ready for reads: ${row.file_scan_status}`,
        409,
      );
    }
    try {
      return readSourceSpan(
        row.file_path,
        row.offset_start,
        row.offset_end,
        this.maxGameBytes,
        row.file_fingerprint,
      );
    } catch (error) {
      if (error instanceof SourceMissingError || error instanceof SourceChangedError) {
        throw new ServiceError(error.message, 409);
      }
      if (error instanceof SourceSpanError) throw new ServiceError(error.message, 422);
      throw error;
    }
  }
}

export function projectFileRow(
  source: IndexFile,
  progress: ProjectionProgress | null = null,
): FileRecord {
  let exists = false;
  let stale = false;
  try {
    sourceStats(source.path);
    exists = true;
    if (source.fingerprint) stale = sourceFingerprint(source.path) !== source.fingerprint;
  } catch {
    // A registered source can disappear after registration; keep its record readable.
  }
  return {
    id: source.id,
    path: source.path,
    name: source.name,
    size: source.size,
    mtime_ns: source.mtime_ns,
    fingerprint: source.fingerprint,
    game_count: source.game_count,
    warning_count: source.warning_count,
    scan_status: source.scan_status,
    scan_error: source.scan_error,
    scanned_at: source.scanned_at,
    exists,
    stale,
    progress: source.scan_status === "scanning" ? progress : null,
  };
}

export function projectGameRow(game: IndexGameRow): GameRecord {
  return {
    id: game.id,
    idx_in_file: game.idx_in_file,
    event: game.event,
    site: game.site,
    date: game.date,
    round: game.round,
    white: game.white,
    black: game.black,
    result: game.result,
    eco: game.eco,
    opening: game.opening,
    has_fen: game.has_fen,
    warning: game.warning,
    byte_size: game.offset_end - game.offset_start,
  };
}

export function projectGamePage(page: IndexGamePage): GamePage {
  return {
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    games: page.games.map(projectGameRow),
  };
}

export function projectGameDocument(
  row: IndexGame,
  hydrated: GameDocumentPayload,
  neighbors: NeighborGameIds,
): GameDocument {
  return {
    ...hydrated,
    gameId: row.id,
    fileId: row.file_id,
    fileName: row.file_name,
    idxInFile: row.idx_in_file,
    neighbors: projectNeighbors(neighbors),
  };
}

export function decodeTagPairs(raw: string): TagPairs {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const headers = parsed.filter(
      (pair): pair is [string, string] =>
        Array.isArray(pair) && pair.length === 2 &&
        typeof pair[0] === "string" && typeof pair[1] === "string",
    );
    return headers.length === parsed.length
      ? headers.map(([name, value]) => [name, value] as TagPair)
      : [];
  } catch {
    return [];
  }
}

export function projectNeighbors(neighbors: NeighborGameIds): NeighborGameIds {
  return { prev: neighbors.prev, next: neighbors.next };
}

export function projectErrorResponse(error: unknown): ProjectedError {
  const statusCode =
    error instanceof ServiceError
      ? error.statusCode
      : typeof error === "object" &&
          error !== null &&
          "statusCode" in error &&
          typeof error.statusCode === "number" &&
          error.statusCode >= 400
        ? error.statusCode
        : 500;
  const detail =
    statusCode >= 500
      ? "Internal Server Error"
      : error instanceof Error
        ? error.message
        : "Request failed";
  return {
    statusCode,
    body: Value.Parse(ErrorResponseSchema, { detail }),
  };
}
