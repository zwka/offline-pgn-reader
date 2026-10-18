import { defineConfig, devices } from "@playwright/test";
import { parseMobileStaticServerOptions } from "./src/mobile-static.js";

const { port } = parseMobileStaticServerOptions({
  rawPort: process.env.PGNREADER_MOBILE_TEST_PORT,
  defaultPort: 8763,
});
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "tests/mobile",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: "line",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  testIgnore: "**/wide.spec.ts",
  projects: [
    {
      name: "android-chromium",
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "ios-webkit",
      use: { ...devices["iPhone 13"] },
    },
  ],
  webServer: {
    command: "npm run build:mobile && npm run serve:mobile",
    env: { PGNREADER_MOBILE_PORT: String(port) },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
