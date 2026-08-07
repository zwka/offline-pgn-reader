import fastifyStatic from "@fastify/static";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import Fastify, { type FastifyInstance } from "fastify";

import { config as defaultConfig, type AppConfig } from "./config.js";
import { createSqliteProbe, LibraryDatabase } from "./database.js";
import { LibraryService, ServiceError } from "./library.js";
import {
  DiscoveredSourceSchema,
  ErrorResponseSchema,
  FileRecordSchema,
  HealthResponseSchema,
  RegisterFileRequestSchema,
  type ErrorResponse,
  type RegisterFileRequest,
} from "./wire.js";

export type ServerOptions = Partial<AppConfig> & {
  databaseProbe?: () => boolean | Promise<boolean>;
};

function errorResponse(detail: string): ErrorResponse {
  return Value.Parse(ErrorResponseSchema, { detail });
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const { databaseProbe, ...configOverrides } = options;
  const appConfig: AppConfig = { ...defaultConfig, ...configOverrides };
  const database = new LibraryDatabase(appConfig.dbPath);
  const library = new LibraryService(database, appConfig.watchDirs);
  const probe = databaseProbe ?? createSqliteProbe(appConfig.dbPath);
  const app = Fastify({
    logger: true,
    ajv: { customOptions: { coerceTypes: false } },
  });

  app.register(fastifyStatic, {
    root: appConfig.frontendDir,
    prefix: "/static/",
  });

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

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send(errorResponse("Not Found")),
  );

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof ServiceError) {
      return reply.code(error.statusCode).send(errorResponse(error.message));
    }
    const statusCode =
      typeof error === "object" &&
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
    return reply.code(statusCode).send(errorResponse(detail));
  });

  return app;
}
