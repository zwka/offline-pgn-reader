import { Type, type Static } from "@sinclair/typebox";

export const HealthResponseSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ok"), Type.Literal("degraded")]),
    version: Type.String(),
    db: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type HealthResponse = Static<typeof HealthResponseSchema>;

export const ErrorResponseSchema = Type.Object(
  { detail: Type.String() },
  { additionalProperties: false },
);

export type ErrorResponse = Static<typeof ErrorResponseSchema>;

export const ResetResponseSchema = Type.Object(
  { status: Type.Literal("reset") },
  { additionalProperties: false },
);

export type ResetResponse = Static<typeof ResetResponseSchema>;

export const ScanStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("scanning"),
  Type.Literal("ready"),
  Type.Literal("error"),
]);

export const ScanProgressSchema = Type.Object(
  {
    bytesDone: Type.Integer({ minimum: 0 }),
    bytesTotal: Type.Integer({ minimum: 0 }),
    gamesFound: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const FileRecordSchema = Type.Object(
  {
    id: Type.Integer({ minimum: 1 }),
    path: Type.String(),
    name: Type.String(),
    size: Type.Integer({ minimum: 0 }),
    mtime_ns: Type.Integer({ minimum: 0 }),
    fingerprint: Type.String(),
    game_count: Type.Integer({ minimum: 0 }),
    warning_count: Type.Integer({ minimum: 0 }),
    scan_status: ScanStatusSchema,
    scan_error: Type.Union([Type.String(), Type.Null()]),
    scanned_at: Type.Union([Type.String(), Type.Null()]),
    exists: Type.Boolean(),
    stale: Type.Boolean(),
    progress: Type.Union([ScanProgressSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export type FileRecord = Static<typeof FileRecordSchema>;

export const GameRecordSchema = Type.Object(
  {
    id: Type.Integer({ minimum: 1 }),
    idx_in_file: Type.Integer({ minimum: 0 }),
    event: Type.String(),
    site: Type.String(),
    date: Type.String(),
    round: Type.String(),
    white: Type.String(),
    black: Type.String(),
    result: Type.String(),
    eco: Type.String(),
    opening: Type.String(),
    has_fen: Type.Integer({ minimum: 0, maximum: 1 }),
    warning: Type.Union([Type.String(), Type.Null()]),
    byte_size: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type GameRecord = Static<typeof GameRecordSchema>;

export const GamePageSchema = Type.Object(
  {
    total: Type.Integer({ minimum: 0 }),
    offset: Type.Integer({ minimum: 0 }),
    limit: Type.Integer({ minimum: 1 }),
    games: Type.Array(GameRecordSchema),
  },
  { additionalProperties: false },
);

export type GamePage = Static<typeof GamePageSchema>;

export const TagPairSchema = Type.Tuple([Type.String(), Type.String()]);
export const TagPairsSchema = Type.Array(TagPairSchema);

export type TagPair = Static<typeof TagPairSchema>;
export type TagPairs = Static<typeof TagPairsSchema>;

export const GameNodeSchema = Type.Object(
  {
    id: Type.Integer({ minimum: 0 }),
    parentId: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    san: Type.Union([Type.String(), Type.Null()]),
    uci: Type.Union([Type.String(), Type.Null()]),
    ply: Type.Integer({ minimum: 0 }),
    moveNumber: Type.Integer({ minimum: 1 }),
    color: Type.Union([Type.Literal(""), Type.Literal("w"), Type.Literal("b")]),
    fen: Type.String(),
    nags: Type.Array(Type.Integer({ minimum: 0 })),
    glyphs: Type.Array(Type.String()),
    comment: Type.String(),
    startingComment: Type.String(),
    children: Type.Array(Type.Integer({ minimum: 0 })),
    arrows: Type.Array(
      Type.Object(
        {
          from: Type.String(),
          to: Type.String(),
          color: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    highlights: Type.Array(
      Type.Object(
        {
          square: Type.String(),
          color: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type GameNode = Static<typeof GameNodeSchema>;

export const GameDocumentSchema = Type.Object(
  {
    gameId: Type.Integer({ minimum: 1 }),
    fileId: Type.Integer({ minimum: 1 }),
    fileName: Type.String(),
    idxInFile: Type.Integer({ minimum: 0 }),
    headers: TagPairsSchema,
    rootId: Type.Integer({ minimum: 0 }),
    nodes: Type.Array(GameNodeSchema),
    result: Type.String(),
    warnings: Type.Array(Type.String()),
    source: Type.String(),
    neighbors: Type.Object(
      {
        prev: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
        next: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type GameDocument = Static<typeof GameDocumentSchema>;
export type GameDocumentPayload = Omit<GameDocument, "gameId" | "fileId" | "fileName" | "idxInFile" | "neighbors">;

export const DiscoveredSourceSchema = Type.Object(
  {
    path: Type.String(),
    name: Type.String(),
    size: Type.Integer({ minimum: 0 }),
    registered: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type DiscoveredSource = Static<typeof DiscoveredSourceSchema>;

export const RegisterFileRequestSchema = Type.Object(
  { path: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export type RegisterFileRequest = Static<typeof RegisterFileRequestSchema>;
