import { expect, test, type Route } from "@playwright/test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolve } from "node:path";
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

test("opens a normal Game record and selects moves across the board and notation", async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-browser-reader-"));
  const source = join(directory, "reader.pgn");
  writeFileSync(
    source,
    [
      '[Event "Browser reader"]',
      '[White "White One"]',
      '[Black "Black One"]',
      '[Result "1-0"]',
      "",
      "1. e4 e5 2. Nf3 Nc6 1-0",
    ].join("\n"),
  );

  try {
    await page.goto("/");
    await page.locator("#path-input").fill(source);
    await page.getByRole("button", { name: "Index path" }).click();
    const card = page.locator(".file-card").filter({ hasText: "reader.pgn" });
    await expect(card).toContainText("1 games", { timeout: 10_000 });

    await card.click();
    await expect(page.locator(".games-table tbody tr")).toHaveCount(1, { timeout: 10_000 });
    await page.locator(".games-table tbody tr").dispatchEvent("click");
    await expect(page.locator(".reader-title")).toContainText("White One");
    await expect(page.locator(".notation .mv")).toHaveCount(4);
    await expect(page.locator('.sq[data-square="e2"] .piece')).toHaveCount(1);

    await page.locator(".notation .mv").filter({ hasText: "e4" }).click();
    await expect(page.locator(".notation .mv.current")).toContainText("e4");
    await expect(page.locator('.sq[data-square="e4"] .piece')).toHaveAttribute("alt", "P");
    await expect(page.locator('.sq[data-square="e2"] .piece')).toHaveCount(0);

    await page.locator(".notation .mv").filter({ hasText: "e5" }).click();
    await expect(page.locator(".notation .mv.current")).toContainText("e5");
    await expect(page.locator('.sq[data-square="e5"] .piece')).toHaveAttribute("alt", "p");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("renders the annotation corpus on notation, warnings, and board graphics", async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-browser-annotations-"));
  const source = join(directory, "annotations.pgn");
  writeFileSync(
    source,
    `${readFileSync(resolve("tests/fixtures/annotations.pgn"), "utf8")}\n${readFileSync(
      resolve("tests/fixtures/graphics.pgn"),
      "utf8",
    )}`,
  );

  try {
    await page.goto("/");
    await page.locator("#path-input").fill(source);
    await page.getByRole("button", { name: "Index path" }).click();
    const card = page.locator(".file-card").filter({ hasText: "annotations.pgn" });
    await expect(card).toContainText("2 games", { timeout: 10_000 });

    await card.click();
    await expect(page.locator(".games-table tbody tr")).toHaveCount(2, { timeout: 10_000 });
    await page.locator(".games-table tbody tr").nth(0).dispatchEvent("click");
    await expect(page.locator(".notation .cmt").filter({ hasText: "Pre-game introduction comment." }))
      .toBeVisible();
    await expect(page.locator(".notation .cmt").filter({ hasText: "semicolon comment" }))
      .toBeVisible();
    await expect(page.locator(".notation .mv").filter({ hasText: "e4" })).toContainText("!");
    await expect(page.locator(".notation .mv").filter({ hasText: "e5" })).toContainText("?!");

    await page.locator(".game-nav button").nth(1).click();
    await expect(page.locator(".notation .cmt").filter({ hasText: "Intro with shapes." }))
      .toBeVisible();
    await expect(page.locator('.sq[data-square="d4"] .csl')).toHaveCount(1);
    await expect(page.locator('.sq[data-square="e5"] .csl')).toHaveCount(1);
    await expect(page.locator(".board-arrows line")).toHaveCount(1);

    await page.locator(".notation .mv").filter({ hasText: "e4" }).click();
    await expect(page.locator('.sq[data-square="e4"] .csl')).toHaveCount(1);
    await expect(page.locator(".board-arrows line")).toHaveCount(2);

    await page.locator(".notation .mv").filter({ hasText: "c5" }).click();
    await expect(page.locator('.sq[data-square="c5"] .csl')).toHaveCount(1);
    await page.keyboard.press("ArrowUp");
    await expect(page.locator(".notation .mv.current")).toContainText("e5");
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".notation .mv.current")).toContainText("c5");

    await page.locator(".notation .mv").filter({ hasText: "c3" }).click();
    await expect(page.locator(".notation .cmt").filter({ hasText: "pre-move shapes" }))
      .toBeVisible();
    await expect(page.locator(".board-arrows line")).toHaveCount(1);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("navigates recursive variations and FEN-start positions in the reader", async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-browser-variations-"));
  const source = join(directory, "variations-and-fen.pgn");
  writeFileSync(
    source,
    `${readFileSync(resolve("tests/fixtures/variations.pgn"), "utf8")}\n${readFileSync(resolve("tests/fixtures/fen_start.pgn"), "utf8")}`,
  );

  try {
    await page.goto("/");
    await page.locator("#path-input").fill(source);
    await page.getByRole("button", { name: "Index path" }).click();
    const card = page.locator(".file-card").filter({ hasText: "variations-and-fen.pgn" });
    await expect(card).toContainText("2 games", { timeout: 10_000 });

    await card.click();
    await expect(page.locator(".games-table tbody tr")).toHaveCount(2, { timeout: 10_000 });
    await page.locator(".games-table tbody tr").nth(0).dispatchEvent("click");
    await expect(page.locator(".notation .mv")).toHaveCount(17);

    await page.locator(".notation .mv").filter({ hasText: "c5" }).click();
    await expect(page.locator(".notation .mv.current")).toContainText("c5");
    await expect(page.locator('.sq[data-square="c5"] .piece')).toHaveAttribute("alt", "p");

    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".notation .mv.current")).toContainText("Nf3");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".notation .mv.current")).toContainText("c5");
    await page.keyboard.press("ArrowUp");
    await expect(page.locator(".notation .mv.current")).toContainText("e5");
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".notation .mv.current")).toContainText("c5");

    await page.locator('a[href^="#/file/"]').click();
    await expect(page.locator(".games-table tbody tr")).toHaveCount(2);
    await page.locator(".games-table tbody tr").nth(1).dispatchEvent("click");
    await expect(page.locator(".notation .mv")).toHaveCount(5);
    await expect(page.locator('.sq[data-square="f7"] .piece')).toHaveAttribute("alt", "R");
    await expect(page.locator('.sq[data-square="f8"] .piece')).toHaveCount(0);

    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".notation .mv.current")).toContainText("Rf8+");
    await expect(page.locator('.sq[data-square="f8"] .piece')).toHaveAttribute("alt", "R");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".notation .mv.current")).toHaveCount(0);
    await expect(page.locator('.sq[data-square="f7"] .piece')).toHaveAttribute("alt", "R");
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
