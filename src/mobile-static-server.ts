import Fastify from "fastify";
import { fileURLToPath } from "node:url";

import {
  parseMobileStaticServerOptions,
  registerMobileStaticRoutes,
} from "./mobile-static.js";

async function main(): Promise<void> {
  const { port } = parseMobileStaticServerOptions({
    rawPort: process.env.PGNREADER_MOBILE_PORT,
    defaultPort: 8431,
  });
  const mobileDir = fileURLToPath(new URL("../mobile/", import.meta.url));
  const app = Fastify({ logger: { level: "info" } });
  registerMobileStaticRoutes({ app, mobileDir });
  const address = await app.listen({ host: "127.0.0.1", port });
  app.log.info({ address }, "Mobile PWA static server listening");
}

await main();
