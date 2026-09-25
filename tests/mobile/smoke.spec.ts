import { expect, test } from "@playwright/test";

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
