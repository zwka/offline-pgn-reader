import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { Type } from "@sinclair/typebox";
import Fastify, { type FastifyInstance } from "fastify";

import { config as defaultConfig, type AppConfig } from "./config.js";
import { createSqliteProbe } from "./database.js";
import { SqliteIndex } from "./index.js";
import { LibraryService } from "./library.js";
import { NotFound, projectErrorResponse, ServiceError } from "./projection.js";
import {
  DiscoveredSourceSchema,
  FileRecordSchema,
  GameDocumentSchema,
  GamePageSchema,
  HealthResponseSchema,
  RegisterFileRequestSchema,
  ResetResponseSchema,
  TagPairsSchema,
  type RegisterFileRequest,
} from "./wire.js";

export type ServerOptions = Partial<AppConfig> & {
  databaseProbe?: () => boolean | Promise<boolean>;
};

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const { databaseProbe, ...configOverrides } = options;
  const appConfig: AppConfig = { ...defaultConfig, ...configOverrides };
  const index = new SqliteIndex(appConfig.dbPath);
  const library = new LibraryService(
    index,
    appConfig.watchDirs,
    appConfig.uploadDir,
    appConfig.maxGameBytes,
  );
  const probe = databaseProbe ?? createSqliteProbe(appConfig.dbPath);
  const app = Fastify({
    logger: { level: appConfig.debug ? "debug" : "info" },
    ajv: { customOptions: { coerceTypes: false } },
  });
  app.addHook("onClose", async () => library.close());

  app.register(fastifyStatic, {
    root: appConfig.mobileDir,
    prefix: "/",
  });
  app.register(fastifyMultipart);

  app.get("/", async (_request, reply) => reply.sendFile("index.html"));

  app.get(
    "/api/health",
    {
      schema: {
        response: {
          200: HealthResponseSchema,
        },
      },
    },
    async () => {
      let db = false;
      try {
        db = await probe();
      } catch {
        db = false;
      }
      return {
        status: db ? "ok" : "degraded",
        version: appConfig.version,
        db,
      };
    },
  );

  app.get(
    "/api/files",
    { schema: { response: { 200: Type.Array(FileRecordSchema) } } },
    async () => library.listFiles(),
  );

  app.post<{ Body: RegisterFileRequest }>(
    "/api/files",
    {
      schema: {
        body: RegisterFileRequestSchema,
        response: { 201: FileRecordSchema },
      },
    },
    async (request, reply) => reply.code(201).send(library.registerFile(request.body.path)),
  );

  app.post(
    "/api/files/upload",
    { schema: { response: { 201: FileRecordSchema } } },
    async (request, reply) => {
      const part = await request.file();
      if (!part || part.fieldname !== "file") {
        throw new ServiceError("multipart field 'file' is required", 400);
      }
      return reply.code(201).send(
        await library.uploadFile(part.filename || "upload.pgn", part.file),
      );
    },
  );

  app.get(
    "/api/discover",
    { schema: { response: { 200: Type.Array(DiscoveredSourceSchema) } } },
    async () => library.discover(),
  );

  app.get<{ Params: { fileId: string } }>(
    "/api/files/:fileId",
    {
      schema: {
        params: Type.Object({ fileId: Type.String({ pattern: "^[1-9][0-9]*$" }) }),
        response: { 200: FileRecordSchema },
      },
    },
    async (request) => library.getFile(Number(request.params.fileId)),
  );

  app.delete<{ Params: { fileId: string } }>(
    "/api/files/:fileId",
    {
      schema: {
        params: Type.Object({ fileId: Type.String({ pattern: "^[1-9][0-9]*$" }) }),
      },
    },
    async (request, reply) => {
      library.removeFile(Number(request.params.fileId));
      return reply.code(204).send();
    },
  );

  app.post<{
    Params: { fileId: string };
    Querystring: { force?: "true" | "false" };
  }>(
    "/api/files/:fileId/rescan",
    {
      schema: {
        params: Type.Object({ fileId: Type.String({ pattern: "^[1-9][0-9]*$" }) }),
        querystring: Type.Object({
          force: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
        }),
      },
    },
    async (request) => {
      const scanStarted = library.startScan(
        Number(request.params.fileId),
        request.query.force !== "false",
      );
      return { ...library.getFile(Number(request.params.fileId)), scanStarted };
    },
  );

  app.post(
    "/api/admin/reset",
    { schema: { response: { 200: ResetResponseSchema } } },
    async () => {
      library.resetIndex();
      return { status: "reset" };
    },
  );

  app.get<{
    Params: { fileId: string };
    Querystring: { q?: string; offset?: string; limit?: string };
  }>(
    "/api/files/:fileId/games",
    {
      schema: {
        params: Type.Object({ fileId: Type.String({ pattern: "^[1-9][0-9]*$" }) }),
        querystring: Type.Object({
          q: Type.Optional(Type.String({ maxLength: 200 })),
          offset: Type.Optional(Type.String({ pattern: "^[0-9]+$" })),
          limit: Type.Optional(Type.String({
            pattern: "^(?:[1-9]|[1-9][0-9]|[1-4][0-9]{2}|500)$",
          })),
        }),
        response: { 200: GamePageSchema },
      },
    },
    async (request) => library.listGames(
      Number(request.params.fileId),
      request.query.q ?? "",
      Number(request.query.offset ?? 0),
      Number(request.query.limit ?? 100),
    ),
  );

  app.get<{ Params: { gameId: string } }>(
    "/api/games/:gameId",
    {
      schema: {
        params: Type.Object({ gameId: Type.String({ pattern: "^[1-9][0-9]*$" }) }),
        response: { 200: GameDocumentSchema },
      },
    },
    async (request) => library.getGameDocument(Number(request.params.gameId)),
  );

  app.get<{ Params: { gameId: string } }>(
    "/api/games/:gameId/pgn",
    {
      schema: {
        params: Type.Object({ gameId: Type.String({ pattern: "^[1-9][0-9]*$" }) }),
      },
    },
    async (request, reply) =>
      reply
        .type("text/plain; charset=utf-8")
        .send(library.getGameSource(Number(request.params.gameId))),
  );

  app.get<{ Params: { gameId: string } }>(
    "/api/games/:gameId/tags",
    {
      schema: {
        params: Type.Object({ gameId: Type.String({ pattern: "^[1-9][0-9]*$" }) }),
        response: { 200: TagPairsSchema },
      },
    },
    async (request) => library.getGameTags(Number(request.params.gameId)),
  );

  app.setNotFoundHandler(async (_request, reply) => {
    const projected = projectErrorResponse(new NotFound("Not Found"));
    return reply.code(projected.statusCode).send(projected.body);
  });

  app.setErrorHandler(async (error, _request, reply) => {
    const projected = projectErrorResponse(error);
    return reply.code(projected.statusCode).send(projected.body);
  });

  return app;
}
