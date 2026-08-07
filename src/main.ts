import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import { buildServer } from "./server.js";

export async function startServer() {
  const server = buildServer();
  try {
    await server.listen({ host: config.host, port: config.port });
  } catch (error) {
    server.log.error({ err: error }, "Failed to start server");
    throw error;
  }
  return server;
}

async function main(): Promise<void> {
  const server = await startServer();
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.log.info(
    { address: `http://${config.host}:${config.port}` },
    "Offline PGN Reader listening",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
