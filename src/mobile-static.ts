import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

export type MobileStaticServerOptions = {
  port: number;
};

export function parseMobileStaticServerOptions({
  rawPort,
  defaultPort,
}: {
  rawPort: string | undefined;
  defaultPort: number;
}): MobileStaticServerOptions {
  const port = Number(rawPort ?? defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Mobile static server port must be an integer between 1 and 65535");
  }
  return { port };
}

export function registerMobileStaticRoutes({
  app,
  mobileDir,
}: {
  app: FastifyInstance;
  mobileDir: string;
}): void {
  app.register(fastifyStatic, {
    root: mobileDir,
    prefix: "/",
  });
  app.get("/", async (_request, reply) => reply.sendFile("index.html"));
}
