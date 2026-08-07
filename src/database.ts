import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function createSqliteProbe(path: string): () => boolean {
  return () => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const database = new Database(path);
      try {
        database.prepare("SELECT 1").get();
        return true;
      } finally {
        database.close();
      }
    } catch {
      return false;
    }
  };
}
