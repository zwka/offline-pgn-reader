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

test("shows a discovered source and registers it from the Library view", async ({ page }) => {
  await page.goto("/");

  const discovered = page.locator(".discover-list li").filter({ hasText: "basic_two_games.pgn" });
  await expect(discovered).toBeVisible();
  await discovered.getByRole("button", { name: "Index" }).click();

  await expect(page.locator(".file-card").filter({ hasText: "basic_two_games.pgn" })).toBeVisible();
  await expect(page.locator(".discover-list li").filter({ hasText: "basic_two_games.pgn" })).toHaveCount(0);

  await page.locator("#path-input").fill("/missing/source.pgn");
  await page.getByRole("button", { name: "Index path" }).click();
  await expect(page.locator('[role="alert"]')).toContainText("not a file");
});
