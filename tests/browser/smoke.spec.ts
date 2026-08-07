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
  const registration = page.waitForResponse((response) =>
    response.url().endsWith("/api/files") && response.request().method() === "POST",
  );
  await discovered.getByRole("button", { name: "Index" }).click();
  const registrationBody = await (await registration).json();
  expect(registrationBody.scan_status).toBe("scanning");
  expect(registrationBody.progress).toMatchObject({
    bytesDone: 0,
    bytesTotal: expect.any(Number),
    gamesFound: 0,
  });

  const card = page.locator(".file-card").filter({ hasText: "basic_two_games.pgn" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("2 games", { timeout: 10_000 });
  await expect(page.locator(".discover-list li").filter({ hasText: "basic_two_games.pgn" })).toHaveCount(0);

  await page.locator("#path-input").fill("/missing/source.pgn");
  await page.getByRole("button", { name: "Index path" }).click();
  await expect(page.locator('[role="alert"]')).toContainText("not a file");

  await card.click();
  await expect(page.locator(".games-table tbody tr")).toHaveCount(2, { timeout: 10_000 });
});

test("uploads a managed copy and refreshes the Library without navigation", async ({ page }) => {
  await page.goto("/");

  const upload = page.locator('input[type="file"]');
  await upload.setInputFiles({
    name: "browser-upload.pgn",
    mimeType: "application/x-chess-pgn",
    buffer: Buffer.from('[Event "Browser upload"]\n\n1. e4 *\n'),
  });

  const card = page.locator(".file-card").filter({ hasText: "browser-upload.pgn" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("1 games", { timeout: 10_000 });
  await expect(page).toHaveURL(/\/$/);
});
