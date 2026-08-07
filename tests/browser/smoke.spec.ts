import { expect, test } from "@playwright/test";

test("loads the browser shell and reaches the Node health route", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Offline PGN Reader");
  await expect(page.locator(".brand")).toContainText("PGN Reader");
  await expect(page.locator("#health-dot")).toHaveClass(/ok/);

  const health = await page.request.get("/api/health");
  expect(health.ok()).toBe(true);
  expect(await health.json()).toEqual({ status: "ok", version: "1.1.0", db: true });
});
