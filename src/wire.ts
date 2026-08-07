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
