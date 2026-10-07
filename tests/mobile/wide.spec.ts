import { expect, test } from "@playwright/test";

test("serves the mobile PWA as the only browser app at a wide viewport", async ({ page }) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
  });

  await page.goto("/");
  await expect(page).toHaveTitle("PGN Reader Mobile");
  await expect(page.locator("#source-input")).toBeVisible();
  await expect(page.locator(".mobile-header")).toBeVisible();

  await page.locator("#source-input").setInputFiles({
    name: "wide-browser.pgn",
    mimeType: "application/x-chess-pgn",
    buffer: Buffer.from('[Event "Wide browser"]\n[White "Desktop viewport"]\n\n1. e4 *\n'),
  });
  await expect(page.locator("#source-status")).toHaveText("ready", { timeout: 10_000 });
  await expect(page.locator("#record-list .game-record")).toHaveCount(1);

  await page.locator("#record-list .game-record").click();
  await expect(page.locator(".reader-title")).toContainText("Desktop viewport");
  await expect(page.locator(".mobile-reader-layout")).toHaveCSS("grid-template-columns", /\S+\s+\S+/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(apiRequests).toEqual([]);
});
