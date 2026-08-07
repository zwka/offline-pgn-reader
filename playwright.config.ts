import { defineConfig, devices } from "@playwright/test";

const port = process.env.PGNREADER_TEST_PORT ?? "8642";
const baseURL = `http://127.0.0.1:${port}`;

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
    command: "npm run dev",
    env: { PGNREADER_PORT: port },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
