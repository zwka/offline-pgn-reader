import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const port = process.env.PGNREADER_TEST_PORT ?? "8642";
const baseURL = `http://127.0.0.1:${port}`;
const browserDataDir = join(tmpdir(), `offline-pgn-reader-playwright-${process.pid}`);

export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: "line",
  use: {
    baseURL,
    trace: "on-first-retry",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "npm start",
    env: {
      PGNREADER_DATA_DIR: browserDataDir,
      PGNREADER_PORT: port,
      PGNREADER_WATCH_DIRS: resolve("tests/fixtures"),
      PGNREADER_UPLOAD_DIR: join(browserDataDir, "library"),
    },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
