import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";

import { config as defaultConfig, type AppConfig } from "./config.js";
import { createSqliteProbe } from "./database.js";
import { HealthResponseSchema } from "./wire.js";

export type ServerOptions = Partial<AppConfig> & {
  databaseProbe?: () => boolean | Promise<boolean>;
};

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const { databaseProbe, ...configOverrides } = options;
  const appConfig: AppConfig = { ...defaultConfig, ...configOverrides };
  const probe = databaseProbe ?? createSqliteProbe(appConfig.dbPath);
  const app = Fastify({ logger: true });

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

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send({ detail: "Not Found" });
  });

  app.setErrorHandler(async (error, _request, reply) => {
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
    return reply.code(statusCode).send({ detail });
  });

  return app;
}
