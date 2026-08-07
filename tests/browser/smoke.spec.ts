import { expect, test, type Route } from "@playwright/test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

test("opens a source and browses paginated, searchable Game records", async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-browser-games-"));
  const source = join(directory, "browse.pgn");
  const content = Array.from({ length: 101 }, (_, index) => {
    const number = index + 1;
    return [
      `[Event "Browse ${number}"]`,
      '[Site "Browser"]',
      '[Date "2024.01.01"]',
      `[Round "${number}"]`,
      `[White "Player ${number}"]`,
      `[Black "Opponent ${number}"]`,
      '[Result "*"]',
      "",
      "1. e4 *",
      "",
    ].join("\n");
  }).join("\n");
  writeFileSync(source, content);

  try {
    await page.goto("/");
    await page.locator("#path-input").fill(source);
    await page.getByRole("button", { name: "Index path" }).click();
    const card = page.locator(".file-card").filter({ hasText: "browse.pgn" });
    await expect(card).toContainText("101 games", { timeout: 10_000 });

    const delayedInitialList = async (route: Route) => {
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 250));
      await route.continue();
    };
    await page.route("**/api/files/*/games**", delayedInitialList);
    await card.click();
    await expect(page.locator("#app .loading")).toBeVisible();
    await expect(page.locator(".games-table tbody tr")).toHaveCount(100, { timeout: 10_000 });
    await expect(page.locator(".pager")).toContainText("1–100 of 101");
    await page.unroute("**/api/files/*/games**", delayedInitialList);

    await page.getByRole("button", { name: "Next ›" }).click();
    await expect(page.locator(".pager")).toContainText("101–101 of 101");
    await expect(page.locator(".games-table tbody tr")).toHaveCount(1);
    await expect(page.locator(".games-table tbody tr")).toContainText("Player 101");

    const delayedSearch = async (route: Route) => {
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 250));
      await route.continue();
    };
    await page.route("**/api/files/*/games**", delayedSearch);
    await page.locator('input[type="search"]').fill("Player 100");
    await expect(page.locator(".stale-state")).toBeVisible();
    await expect(page.locator(".games-table tbody tr")).toContainText("Player 100", { timeout: 10_000 });
    await page.unroute("**/api/files/*/games**", delayedSearch);

    await page.locator('input[type="search"]').fill("does-not-exist");
    await expect(page.locator(".empty-state")).toContainText("No games match this search.", { timeout: 10_000 });
    await page.locator('input[type="search"]').fill("Player 101");
    await expect(page.locator(".games-table tbody tr")).toContainText("Player 101", { timeout: 10_000 });

    const failedList = async (route: Route) => route.abort();
    await page.route("**/api/files/*/games**", failedList);
    await page.locator('input[type="search"]').fill("Player 1");
    await expect(page.locator(".request-error")).toContainText("Could not load games", { timeout: 10_000 });
    await expect(page.locator(".games-table tbody tr")).toContainText("Player 101");
    await page.unroute("**/api/files/*/games**", failedList);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("shows a changed source as stale and rescans it from the Library", async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-browser-stale-"));
  const source = join(directory, "changed.pgn");
  writeFileSync(source, '[Event "Changed"]\n\n1. e4 *\n');

  try {
    await page.goto("/");
    await page.locator("#path-input").fill(source);
    await page.getByRole("button", { name: "Index path" }).click();
    const card = page.locator(".file-card").filter({ hasText: "changed.pgn" });
    await expect(card).toContainText("1 games", { timeout: 10_000 });

    appendFileSync(source, "\n");
    await page.reload();
    await expect(card.locator(".badge.stale")).toBeVisible();
    await expect(card.getByRole("button", { name: "Re-scan (changed)" })).toBeVisible();

    await card.click();
    await expect(page.locator(".source-stale")).toContainText("source changed");
    await expect(page.locator(".games-table tbody tr")).toHaveCount(1);
    await page.goto("/");

    await card.getByRole("button", { name: "Re-scan (changed)" }).click();
    await expect(card.locator(".badge.ready")).toBeVisible({ timeout: 10_000 });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
