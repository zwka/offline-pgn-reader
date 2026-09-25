import { defineConfig, devices } from "@playwright/test";

const port = process.env.PGNREADER_MOBILE_TEST_PORT ?? "8763";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "tests/mobile",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: "line",
  use: {
    baseURL,
    trace: "on-first-retry",
    ...devices["Pixel 7"],
  },
  webServer: {
    command: `npm run build:mobile && python3 -m http.server ${port} --bind 127.0.0.1 --directory mobile`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
