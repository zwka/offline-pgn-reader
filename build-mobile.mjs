import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const vendorDirectory = join(root, "mobile", "dist", "vendor");

await mkdir(vendorDirectory, { recursive: true });
await cp(
  join(root, "node_modules", "chess.js", "dist", "esm", "chess.js"),
  join(vendorDirectory, "chess.js"),
  { force: true },
);
await cp(
  join(root, "node_modules", "chess.js", "src", "pgn.js"),
  join(vendorDirectory, "pgn.js"),
  { force: true },
);
await cp(
  join(root, "frontend", "pieces"),
  join(root, "mobile", "pieces"),
  { recursive: true, force: true },
);
