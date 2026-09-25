import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const twoGames = Buffer.from([
  '[Event "Mobile one"]',
  '[Site "Local"]',
  '[Date "2024.01.01"]',
  '[Round "1"]',
  '[White "White One"]',
  '[Black "Black One"]',
  '[Result "1-0"]',
  '[ECO "C20"]',
  '[Opening "King Pawn"]',
  "",
  "1. e4 e5 1-0",
  "",
  '[Event "Mobile two"]',
  '[Site "Local"]',
  '[Date "2024.01.02"]',
  '[Round "2"]',
  '[White "White Two"]',
  '[Black "Black Two"]',
  '[Result "0-1"]',
  '[ECO "D00"]',
  '[Opening "Queen Pawn"]',
  "",
  "1. d4 d5 0-1",
  "",
].join("\n"));

test("loads as a standalone static mobile client and imports one source", async ({ page }) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
  });

  await page.goto("/");
  await expect(page).toHaveTitle("PGN Reader Mobile");
  await expect(page.locator("#source-status")).toHaveText("idle");

  await page.locator("#source-input").setInputFiles({
    name: "mobile-study.pgn",
    mimeType: "application/x-chess-pgn",
    buffer: twoGames,
  });

  await expect(page.locator("#source-status")).toHaveText("ready", { timeout: 10_000 });
  await expect(page.locator("#source-name")).toHaveText("mobile-study.pgn");
  await expect(page.locator("#source-size")).toContainText("B");
  await expect(page.locator("#game-count")).toHaveText("2");
  await expect(page.locator("#scan-progress-label")).toHaveText("Scan complete.");
  await expect(page.locator("#record-list .game-record")).toHaveCount(2);
  expect(apiRequests).toEqual([]);
});

test("keeps the main thread usable and bounds the searchable Game record list", async ({ page }) => {
  const source = Array.from({ length: 101 }, (_, index) => {
    const number = index + 1;
    return [
      `[Event "Event ${number}"]`,
      `[Site "Site ${number}"]`,
      `[Date "2024.01.01"]`,
      `[Round "${number}"]`,
      `[White "Player ${number}"]`,
      `[Black "Opponent ${number}"]`,
      '[Result "*"]',
      `[ECO "C${String(number).padStart(2, "0")}"]`,
      `[Opening "Opening ${number}"]`,
      "",
      "1. e4 *",
      "",
    ].join("\n");
  }).join("\n");

  await page.goto("/");
  await page.locator("#source-input").setInputFiles({
    name: "bounded.pgn",
    mimeType: "application/x-chess-pgn",
    buffer: Buffer.from(source),
  });

  await page.locator("#metadata-search").fill("Player 100");
  await expect(page.locator("#metadata-search")).toHaveValue("Player 100");
  await expect(page.locator("#source-status")).toHaveText("ready", { timeout: 10_000 });
  await page.locator("#metadata-search").fill("");
  await expect(page.locator("#record-list .game-record")).toHaveCount(50);
  await expect(page.locator("#list-summary")).toHaveText("1-50 of 101");

  await page.locator("#metadata-search").fill("Player 100");
  await expect(page.locator("#record-list .game-record")).toHaveCount(1);
  await expect(page.locator("#record-list")).toContainText("Player 100");
  await expect(page.locator("#record-list")).toContainText("Opening 100");
});

test("replaces the active Mobile Library source", async ({ page }) => {
  await page.goto("/");
  await page.locator("#source-input").setInputFiles({
    name: "first.pgn",
    mimeType: "application/x-chess-pgn",
    buffer: Buffer.from('[Event "First"]\n[White "One"]\n\n1. e4 *\n'),
  });
  await expect(page.locator("#source-status")).toHaveText("ready", { timeout: 10_000 });

  await page.locator("#source-input").setInputFiles({
    name: "replacement.pgn",
    mimeType: "application/x-chess-pgn",
    buffer: Buffer.from('[Event "Replacement"]\n[White "Two"]\n\n1. d4 *\n'),
  });

  await expect(page.locator("#source-status")).toHaveText("ready", { timeout: 10_000 });
  await expect(page.locator("#source-name")).toHaveText("replacement.pgn");
  await expect(page.locator("#record-list .game-record")).toHaveCount(1);
  await expect(page.locator("#record-list")).toContainText("Replacement");
  await expect(page.locator("#record-list")).not.toContainText("First");
  await expect(page.locator(".source-panel")).toHaveCount(1);
});

test("opens Game records in the local reader with annotations, FEN starts, and neighbors", async ({ page }) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
  });
  const source = Buffer.from([
    readFileSync(resolve("tests/fixtures/annotations.pgn"), "utf8").trimEnd(),
    readFileSync(resolve("tests/fixtures/graphics.pgn"), "utf8").trimEnd(),
    readFileSync(resolve("tests/fixtures/fen_start.pgn"), "utf8").trimEnd(),
    [
      '[Event "Warning"]',
      '[Event "Warning duplicate"]',
      '[White "Warnings"]',
      '[SetUp "1"]',
      '[FEN "not a FEN"]',
      '[Result "*"]',
      "",
      "1. e4 *",
    ].join("\n"),
  ].join("\n\n"));

  await page.goto("/");
  await page.locator("#source-input").setInputFiles({
    name: "mobile-reader.pgn",
    mimeType: "application/x-chess-pgn",
    buffer: source,
  });
  await expect(page.locator("#source-status")).toHaveText("ready", { timeout: 10_000 });
  await expect(page.locator("#record-list .game-record")).toHaveCount(4);

  await page.locator("#record-list .game-record").nth(0).click();
  await expect(page.locator("#reader-panel")).toBeVisible();
  await expect(page.locator(".reader-title")).toContainText("Annotator");
  await expect(page.locator('.board .sq[data-square="e2"] .piece')).toHaveAttribute("alt", "P");
  await expect(page.locator(".notation-body .cmt").first()).toContainText("Pre-game introduction comment.");
  await expect(page.locator(".notation-body .mv").filter({ hasText: "e4" }).first()).toContainText("!");
  await expect(page.locator(".notation-body .mv").filter({ hasText: "e5" }).first()).toContainText("?!");

  await page.locator(".notation-body .mv").filter({ hasText: "e4" }).first().click();
  await expect(page.locator(".notation-body .mv.current")).toContainText("e4");
  await expect(page.locator('.board .sq[data-square="e4"] .piece')).toHaveAttribute("alt", "P");
  await page.locator('[data-action="back"]').click();
  await expect(page.locator('.board .sq[data-square="e2"] .piece')).toHaveAttribute("alt", "P");
  await page.locator('[data-action="forward"]').click();
  await expect(page.locator(".notation-body .mv.current")).toContainText("e4");
  await page.locator('[data-action="end"]').click();
  await expect(page.locator(".notation-body .mv.current")).toContainText("Ba4");
  await page.locator('[data-action="start"]').click();
  await expect(page.locator(".notation-body .mv.current")).toHaveCount(0);

  await page.locator(".meta-panel summary").click();
  expect(await page.locator(".meta-table tr").evaluateAll((rows) =>
    rows.map((row) => Array.from(row.querySelectorAll("td"), (cell) => cell.textContent)),
  )).toEqual([
    ["Event", "Annotated"],
    ["Site", "?"],
    ["Date", "????.??.??"],
    ["Round", "?"],
    ["White", "Annotator"],
    ["Black", "Reader"],
    ["Result", "*"],
  ]);

  await page.locator('[data-action="next-game"]').click();
  await expect(page.locator(".reader-title")).toContainText("Arrows");
  await expect(page.locator('.board .sq[data-square="d4"] .csl')).toHaveCount(1);
  await expect(page.locator('.board .sq[data-square="e5"] .csl')).toHaveCount(1);
  await expect(page.locator(".board-arrows line")).toHaveCount(1);
  await expect(page.locator(".variation .mv").first()).toContainText("c5");
  await page.locator(".variation .mv").filter({ hasText: "c5" }).first().click();
  await expect(page.locator(".notation-body .mv.current")).toContainText("c5");
  await expect(page.locator('.board .sq[data-square="c5"] .piece')).toHaveAttribute("alt", "p");
  await page.locator(".notation-body .mv").filter({ hasText: "e4" }).first().click();
  await expect(page.locator('.board .sq[data-square="e4"] .csl')).toHaveCount(1);
  await expect(page.locator(".board-arrows line")).toHaveCount(2);
  await page.locator('[data-action="next-game"]').click();
  await expect(page.locator(".reader-title")).toContainText("Lucena");
  await expect(page.locator('.board .sq[data-square="f7"] .piece')).toHaveAttribute("alt", "R");
  await expect(page.locator('.board .sq[data-square="f8"] .piece')).toHaveCount(0);
  await page.locator('[data-action="forward"]').click();
  await expect(page.locator(".notation-body .mv.current")).toContainText("Rf8+");
  await expect(page.locator('.board .sq[data-square="f8"] .piece')).toHaveAttribute("alt", "R");
  await page.locator('[data-action="next-game"]').click();
  await expect(page.locator(".reader-title")).toContainText("Warnings");
  await expect(page.locator(".reader-warning")).toContainText("invalid FEN");
  await page.locator(".meta-panel summary").click();
  await expect(page.locator(".meta-table tr")).toHaveCount(6);
  await page.getByRole("button", { name: "Raw PGN source" }).click();
  await expect(page.locator(".raw-source")).toContainText('[Event "Warning duplicate"]');
  await page.locator('[data-action="previous-game"]').click();
  await expect(page.locator(".reader-title")).toContainText("Lucena");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  const controlSizes = await page.locator(".reader-control").evaluateAll((buttons) =>
    buttons.map((button) => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })),
  );
  expect(controlSizes.every(({ width, height }) => width >= 40 && height >= 40)).toBe(true);
  expect(apiRequests).toEqual([]);
});

test("yields while rendering a large mobile notation document", async ({ page }) => {
  const variations = Array.from({ length: 1_800 }, () => "(1. d4)").join(" ");
  const source = Buffer.from([
    '[Event "Large notation"]',
    '[White "Many lines"]',
    '[Black "Reader"]',
    "",
    `1. e4 ${variations} *`,
  ].join("\n"));

  await page.goto("/");
  await page.locator("#source-input").setInputFiles({
    name: "large-notation.pgn",
    mimeType: "application/x-chess-pgn",
    buffer: source,
  });
  await expect(page.locator("#source-status")).toHaveText("ready", { timeout: 10_000 });
  const ticksDuringRender = page.evaluate(() => new Promise<number>((resolveTimer) => {
    let ticks = 0;
    const timer = window.setInterval(() => { ticks += 1; }, 0);
    window.setTimeout(() => {
      window.clearInterval(timer);
      resolveTimer(ticks);
    }, 250);
  }));
  await page.locator("#record-list .game-record").click();
  await expect(page.locator(".notation-body .mv")).toHaveCount(1_801, { timeout: 10_000 });
  expect(await ticksDuringRender).toBeGreaterThan(0);
});
