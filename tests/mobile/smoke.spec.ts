import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  MOBILE_MAX_GAME_BYTES,
  MOBILE_MAX_SOURCE_BYTES,
} from "../../src/mobile/library.js";

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

test("switches the mobile theme and restores it after reload", async ({ page }) => {
  await page.goto("/");

  const toggle = page.getByRole("button", { name: "Switch to dark mode" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "Switch to light mode" })).toBeVisible();

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "Switch to light mode" })).toBeVisible();
});

test("restores the persisted Mobile Library after reload and clears it", async ({ page }) => {
  const source = Buffer.from([
    '[Event "Persistent mobile source"]',
    '[White "Reloaded"]',
    '[Black "Reader"]',
    "",
    "1. e4 *",
    "",
  ].join("\n"));

  await page.goto("/");
  await page.locator("#source-input").setInputFiles({
    name: "persistent-mobile.pgn",
    mimeType: "application/x-chess-pgn",
    buffer: source,
  });
  await expect(page.locator("#source-status")).toHaveText("ready", { timeout: 10_000 });
  await expect(page.locator("#record-list .game-record")).toHaveCount(1);

  await page.reload();
  await expect(page.locator("#source-status")).toHaveText("ready", { timeout: 10_000 });
  await expect(page.locator("#source-name")).toHaveText("persistent-mobile.pgn");
  await expect(page.locator("#record-list .game-record")).toHaveCount(1);
  await page.locator("#record-list .game-record").click();
  await expect(page.locator(".reader-title")).toContainText("Reloaded");
  await page.getByRole("button", { name: "Raw PGN source" }).click();
  await expect(page.locator(".raw-source")).toContainText('[Event "Persistent mobile source"]');

  await page.getByRole("button", { name: "Back to Game records" }).click();
  await page.locator("#clear-source").click();
  await expect(page.locator("#source-status")).toHaveText("idle");
  await expect(page.locator("#source-name")).toHaveText("No PGN source selected");
  await expect(page.locator("#record-list .game-record")).toHaveCount(0);

  await page.reload();
  await expect(page.locator("#source-status")).toHaveText("idle");
  await expect(page.locator("#record-list .game-record")).toHaveCount(0);
});

test("creates per-source Resume bookmarks, continues from the root, and removes them with a source", async ({ page }) => {
  const firstSource = twoGames;
  const secondSource = Buffer.from('[Event "Resume second"]\n[White "Second"]\n[Black "Reader"]\n\n1. c4 *\n');

  await page.goto("/");
  await page.locator("#source-input").setInputFiles({
    name: "resume-first.pgn",
    mimeType: "application/x-chess-pgn",
    buffer: firstSource,
  });
  await expect(page.locator("#source-status")).toHaveText("ready", { timeout: 10_000 });
  await expect(page.locator("#record-list .game-record")).toHaveCount(2);
  await expect(page.locator("#source-list .source-continue")).toHaveCount(0);

  await page.locator("#record-list .game-record").first().click();
  await expect(page.locator(".reader-title")).toContainText("White One");
  await expect(page.locator(".notation-body .mv.current")).toHaveCount(0);
  await page.locator('[data-action="next-game"]').click();
  await expect(page.locator(".reader-title")).toContainText("White Two");
  await page.locator('[data-action="previous-game"]').click();
  await expect(page.locator(".reader-title")).toContainText("White One");
  await page.locator('[data-action="next-game"]').click();
  await expect(page.locator(".reader-title")).toContainText("White Two");
  await page.locator('[data-action="forward"]').click();
  await expect(page.locator(".notation-body .mv.current")).toContainText("d4");
  await page.getByRole("button", { name: "Back to Game records" }).click();

  const firstItem = page.locator("#source-list .source-item").filter({ hasText: "resume-first.pgn" });
  await expect(firstItem.getByRole("button", { name: "Continue" })).toBeVisible();

  await page.locator("#source-input").setInputFiles({
    name: "resume-second.pgn",
    mimeType: "application/x-chess-pgn",
    buffer: secondSource,
  });
  await expect(page.locator("#source-name")).toHaveText("resume-second.pgn", { timeout: 10_000 });
  const secondItem = page.locator("#source-list .source-item").filter({ hasText: "resume-second.pgn" });
  await expect(secondItem.locator(".source-continue")).toHaveCount(0);
  await page.locator("#record-list .game-record").click();
  await expect(page.locator(".reader-title")).toContainText("Second");
  await page.getByRole("button", { name: "Back to Game records" }).click();
  await expect(secondItem.getByRole("button", { name: "Continue" })).toBeVisible();

  await page.getByRole("button", { name: "Select resume-first.pgn" }).click();
  await expect(page.locator("#source-name")).toHaveText("resume-first.pgn");
  await page.reload();
  await expect(page.locator("#source-name")).toHaveText("resume-first.pgn", { timeout: 10_000 });
  await expect(page.locator("#reader-panel")).toBeHidden();
  await page.locator("#source-list .source-item").filter({ hasText: "resume-first.pgn" })
    .getByRole("button", { name: "Continue" }).click();
  await expect(page.locator(".reader-title")).toContainText("White Two");
  await expect(page.locator(".notation-body .mv.current")).toHaveCount(0);
  await expect(page.locator('.board .sq[data-square="e2"] .piece')).toHaveAttribute("alt", "P");

  await page.getByRole("button", { name: "Back to Game records" }).click();
  await page.getByRole("button", { name: "Remove resume-first.pgn" }).click();
  await expect(page.locator("#source-status")).toHaveText("idle");
  await expect(page.getByRole("button", { name: "Remove resume-first.pgn" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(1);

  await page.reload();
  await expect(page.locator("#source-status")).toHaveText("idle", { timeout: 10_000 });
  await expect(page.locator("#source-name")).toHaveText("No PGN source selected");
  await expect(page.locator("#source-list .source-select-name")).toHaveText(["resume-second.pgn"]);
  await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(1);
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

test("retains, orders, switches, removes, and restores Mobile Library sources", async ({ page }) => {
  await page.goto("/");
  await page.locator("#source-input").setInputFiles({
    name: "zeta.pgn",
    mimeType: "application/x-chess-pgn",
    buffer: Buffer.from('[Event "Zeta"]\n[White "One"]\n\n1. e4 *\n'),
  });
  await expect(page.locator("#source-status")).toHaveText("ready", { timeout: 10_000 });

  await page.locator("#source-input").setInputFiles({
    name: "Alpha.pgn",
    mimeType: "application/x-chess-pgn",
    buffer: Buffer.from('[Event "Alpha"]\n[White "Two"]\n\n1. d4 *\n'),
  });

  await expect(page.locator("#source-status")).toHaveText("ready", { timeout: 10_000 });
  await expect(page.locator("#source-name")).toHaveText("Alpha.pgn");
  await expect(page.locator("#record-list .game-record")).toHaveCount(1);
  await expect(page.locator("#record-list")).toContainText("Alpha");
  await expect(page.locator("#source-list .source-select-name")).toHaveText(["Alpha.pgn", "zeta.pgn"]);
  await expect(page.getByRole("button", { name: "Select Alpha.pgn" })).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("button", { name: "Select zeta.pgn" })).not.toHaveAttribute("aria-current");

  await page.locator("#source-input").setInputFiles({
    name: "ZETA.PGN",
    mimeType: "application/x-chess-pgn",
    buffer: Buffer.from('[Event "Different bytes"]\n\n1. c4 *\n'),
  });
  await expect(page.locator("#source-error")).toContainText("already retained");
  await expect(page.locator("#source-name")).toHaveText("Alpha.pgn");
  await expect(page.locator("#source-list .source-select-name")).toHaveText(["Alpha.pgn", "zeta.pgn"]);

  await page.getByRole("button", { name: "Select zeta.pgn" }).click();
  await expect(page.locator("#source-name")).toHaveText("zeta.pgn");
  await expect(page.locator("#record-list")).toContainText("Zeta");
  await expect(page.locator("#reader-panel")).toBeHidden();

  await page.reload();
  await expect(page.locator("#source-name")).toHaveText("zeta.pgn", { timeout: 10_000 });
  await expect(page.locator("#source-list .source-select-name")).toHaveText(["Alpha.pgn", "zeta.pgn"]);
  await expect(page.locator("#record-list")).toContainText("Zeta");

  await page.getByRole("button", { name: "Remove Alpha.pgn" }).click();
  await expect(page.locator("#source-name")).toHaveText("zeta.pgn");
  await expect(page.locator("#source-list .source-select-name")).toHaveText(["zeta.pgn"]);
  await page.getByRole("button", { name: "Remove zeta.pgn" }).click();
  await expect(page.locator("#source-status")).toHaveText("idle");
  await expect(page.locator("#source-name")).toHaveText("No PGN source selected");
  await expect(page.locator("#record-list .game-record")).toHaveCount(0);
});

test("keeps retained sources after a failed import and recovers on retry", async ({ page }) => {
  await page.goto("/");
  await page.locator("#source-input").setInputFiles({
    name: "active-source.pgn",
    mimeType: "application/x-chess-pgn",
    buffer: Buffer.from('[Event "Active"]\n[White "Kept"]\n\n1. e4 *\n'),
  });
  await expect(page.locator("#source-status")).toHaveText("ready", { timeout: 10_000 });

  await page.locator("#source-input").setInputFiles({
    name: "not-a-pgn.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("replacement failed"),
  });
  await expect(page.locator("#source-error")).toContainText("ends in .pgn");
  await expect(page.locator("#source-name")).toHaveText("active-source.pgn");
  await expect(page.locator("#record-list .game-record")).toHaveCount(1);
  await expect(page.locator("#record-list")).toContainText("Kept");

  await page.locator("#source-input").setInputFiles({
    name: "recovered-source.pgn",
    mimeType: "application/x-chess-pgn",
    buffer: Buffer.from('[Event "Recovered"]\n[White "New source"]\n\n1. d4 *\n'),
  });
  await expect(page.locator("#source-status")).toHaveText("ready", { timeout: 10_000 });
  await expect(page.locator("#source-name")).toHaveText("recovered-source.pgn");
  await expect(page.locator("#source-error")).toBeHidden();
  await expect(page.locator("#record-list .game-record")).toHaveCount(1);
  await expect(page.locator("#record-list")).toContainText("New source");
  await expect(page.locator("#record-list")).not.toContainText("Kept");
  await expect(page.locator("#source-list .source-select-name")).toHaveText(["active-source.pgn", "recovered-source.pgn"]);
});

test("keeps the active source during a cancellable source add", async ({ page }) => {
  await page.goto("/");
  await page.locator("#source-input").setInputFiles({
    name: "active-during-add.pgn",
    mimeType: "application/x-chess-pgn",
    buffer: Buffer.from('[Event "Active during add"]\n[White "Kept"]\n\n1. e4 *\n'),
  });
  await expect(page.locator("#source-status")).toHaveText("ready", { timeout: 10_000 });

  await page.locator("#source-input").setInputFiles({
    name: "cancelled-add.pgn",
    mimeType: "application/x-chess-pgn",
    buffer: cancellableSource(),
  });
  await expect(page.getByRole("button", { name: "Cancel add" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#source-name")).toHaveText("active-during-add.pgn");
  await expect(page.locator("#record-list")).toContainText("Kept");

  await page.getByRole("button", { name: "Cancel add" }).click();
  await expect(page.locator("#source-error")).toContainText("cancelled");
  await expect(page.locator("#source-name")).toHaveText("active-during-add.pgn");
  await expect(page.locator("#record-list .game-record")).toHaveCount(1);
  await expect(page.locator("#source-list .source-select-name")).toHaveText(["active-during-add.pgn"]);
});

test("accepts the 50 MiB source boundary and rejects oversized Game records", async ({ page }, testInfo) => {
  testInfo.setTimeout(60_000);
  const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-mobile-boundaries-"));
  try {
    const boundaryPath = join(directory, "source-boundary.pgn");
    const oversizedPath = join(directory, "oversized-source.pgn");
    const largeGamePath = join(directory, "oversized-game.pgn");
    writeFileSync(boundaryPath, sourceAtLimit());
    writeFileSync(oversizedPath, Buffer.alloc(MOBILE_MAX_SOURCE_BYTES + 1));
    writeFileSync(largeGamePath, sourceWithGameOverLimit());

    await page.goto("/");
    await page.locator("#source-input").setInputFiles(boundaryPath);
    await expect(page.locator("#source-status")).toHaveText("ready", { timeout: 30_000 });
    await expect(page.locator("#source-size")).toHaveText("50.0 MB");
    await expect(page.locator("#game-count")).toHaveText("1");
    await expect(page.locator("#scan-progress")).toBeVisible();
    expect(await page.locator("#scan-progress").evaluate((progress) => ({
      value: (progress as HTMLProgressElement).value,
      max: (progress as HTMLProgressElement).max,
    }))).toEqual({ value: MOBILE_MAX_SOURCE_BYTES, max: MOBILE_MAX_SOURCE_BYTES });
    await expect(page.locator("#scan-progress-label")).toHaveText("Scan complete.");

    await page.locator("#source-input").setInputFiles(oversizedPath);
    await expect(page.locator("#source-error")).toContainText("50 MiB");
    await expect(page.locator("#source-status")).toHaveText("ready");
    await expect(page.locator("#source-name")).toHaveText("source-boundary.pgn");
    await expect(page.locator("#record-list .game-record")).toHaveCount(1);

    await page.locator("#source-input").setInputFiles(largeGamePath);
    await expect(page.locator("#source-error")).toContainText("8 MiB", { timeout: 30_000 });
    await expect(page.locator("#source-status")).toHaveText("ready");
    await expect(page.locator("#source-name")).toHaveText("source-boundary.pgn");
    await expect(page.locator("#record-list .game-record")).toHaveCount(1);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("opens Game records in the local reader with annotations, FEN starts, and neighbors", async ({ page }) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
  });
  const source = Buffer.from([
    readFileSync(resolve("tests/fixtures/annotations.pgn"), "utf8").trimEnd(),
    readFileSync(resolve("tests/fixtures/graphics.pgn"), "utf8").trimEnd(),
    readFileSync(resolve("tests/fixtures/variations.pgn"), "utf8").trimEnd(),
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
  await expect(page.locator("#record-list .game-record")).toHaveCount(5);

  await page.locator("#record-list .game-record").nth(0).tap();
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

   await page.locator('[data-action="next-game"]').tap();
   await expect(page.locator(".reader-title")).toContainText("Arrows");
   await expect(page.locator('.board .sq[data-square="d4"] .csl')).toHaveCount(1);
   await expect(page.locator('.board .sq[data-square="e5"] .csl')).toHaveCount(1);
   await expect(page.locator(".board-arrows line")).toHaveCount(1);
   const lightArrowColor = await page.locator(".board-arrows g").first()
     .evaluate((element) => getComputedStyle(element).fill);
   await page.getByRole("button", { name: "Switch to dark mode" }).click();
   const darkArrowColor = await page.locator(".board-arrows g").first()
     .evaluate((element) => getComputedStyle(element).fill);
   expect(darkArrowColor).not.toBe(lightArrowColor);
   await expect(page.locator(".variation .mv").first()).toContainText("c5");
  await page.locator(".variation .mv").filter({ hasText: "c5" }).first().click();
  await expect(page.locator(".notation-body .mv.current")).toContainText("c5");
  await expect(page.locator('.board .sq[data-square="c5"] .piece')).toHaveAttribute("alt", "p");
  await page.locator(".notation-body .mv").filter({ hasText: "e4" }).first().click();
  await expect(page.locator('.board .sq[data-square="e4"] .csl')).toHaveCount(1);
  await expect(page.locator(".board-arrows line")).toHaveCount(2);
  await page.locator('[data-action="next-game"]').tap();
  await expect(page.locator(".reader-title")).toContainText("Tree - Builder");
  expect(await page.locator(".variation").count()).toBeGreaterThan(0);
  await page.locator('[data-action="next-game"]').tap();
  await expect(page.locator(".reader-title")).toContainText("Lucena");
  await expect(page.locator('.board .sq[data-square="f7"] .piece')).toHaveAttribute("alt", "R");
  await expect(page.locator('.board .sq[data-square="f8"] .piece')).toHaveCount(0);
  await page.locator('[data-action="forward"]').click();
  await expect(page.locator(".notation-body .mv.current")).toContainText("Rf8+");
  await expect(page.locator('.board .sq[data-square="f8"] .piece')).toHaveAttribute("alt", "R");
  await page.locator('[data-action="next-game"]').tap();
  await expect(page.locator(".reader-title")).toContainText("Warnings");
  await expect(page.locator(".reader-warning")).toContainText("invalid FEN");
  await page.locator(".meta-panel summary").click();
  expect(await page.locator(".meta-table tr").evaluateAll((rows) =>
    rows.map((row) => Array.from(row.querySelectorAll("td"), (cell) => cell.textContent)),
  )).toEqual([
    ["Event", "Warning"],
    ["Event", "Warning duplicate"],
    ["White", "Warnings"],
    ["SetUp", "1"],
    ["FEN", "not a FEN"],
    ["Result", "*"],
  ]);
  await page.getByRole("button", { name: "Raw PGN source" }).click();
  await expect(page.locator(".raw-source")).toContainText('[Event "Warning duplicate"]');
  await page.locator('[data-action="previous-game"]').tap();
  await expect(page.locator(".reader-title")).toContainText("Lucena");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  const controlSizes = await page.locator(".reader-control").evaluateAll((buttons) =>
    buttons.map((button) => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })),
  );
  expect(controlSizes.every(({ width, height }) => width >= 40 && height >= 40)).toBe(true);
  expect(await phoneLayout(page)).toEqual({
    horizontalOverflow: false,
    controlsOutsideViewport: false,
    controlOverlap: false,
    contentOverlap: false,
  });
  expect(apiRequests).toEqual([]);
});

test("keeps mobile move controls focused on the board", async ({ page }) => {
  const note = "A deliberately long study note keeps the notation pane scrollable. ".repeat(12);
  const source = Buffer.from([
    '[Event "Mobile focus"]',
    '[White "White"]',
    '[Black "Black"]',
    '[Result "*"]',
    "",
    `{${note}} 1. e4 {${note}} e5 {${note}} 2. Nf3 {${note}} Nc6 {${note}} 3. Bb5 {${note}} a6 {${note}} 4. Ba4 *`,
  ].join("\n"));

  await page.goto("/");
  await page.locator("#source-input").setInputFiles({
    name: "mobile-focus.pgn",
    mimeType: "application/x-chess-pgn",
    buffer: source,
  });
  await expect(page.locator("#source-status")).toHaveText("ready", { timeout: 10_000 });
  await page.locator("#record-list .game-record").click();
  await expect(page.locator(".notation-body .mv")).toHaveCount(7);

  const notation = page.locator(".mobile-notation");
  await notation.evaluate((element) => { element.scrollTop = 0; });
  await page.locator('[data-action="end"]').click();

  await expect(page.locator(".notation-body .mv.current")).toContainText("Ba4");
  expect(await page.evaluate(() => document.activeElement?.classList.contains("board"))).toBe(true);
  expect(await notation.evaluate((element) => element.scrollTop)).toBe(0);
});

test("shows malformed-record warnings from the mobile GameDocument reader", async ({ page }) => {
  await page.goto("/");
  await page.locator("#source-input").setInputFiles({
    name: "malformed-mobile.pgn",
    mimeType: "application/x-chess-pgn",
    buffer: readFileSync(resolve("tests/fixtures/malformed_middle.pgn")),
  });
  await expect(page.locator("#source-status")).toHaveText("ready", { timeout: 10_000 });
  await expect(page.locator("#record-list .game-record")).toHaveCount(3);
  await page.locator("#metadata-search").fill("Second");
  await expect(page.locator("#record-list .game-record")).toHaveCount(1);
  await page.locator("#record-list .game-record").tap();
  await expect(page.locator(".reader-title")).toContainText("Second - Bad");
  await expect(page.locator(".reader-warning")).toContainText("could not parse move");
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

function sourceAtLimit(): Buffer {
  const prefix = Buffer.from('[Event "50 MiB boundary"]\n[White "Boundary"]\n\n1. e4 *\n');
  return Buffer.concat([prefix, Buffer.alloc(MOBILE_MAX_SOURCE_BYTES - prefix.byteLength, 0x20)]);
}

function sourceWithGameOverLimit(): Buffer {
  const prefix = Buffer.from('[Event "8 MiB boundary"]\n\n{');
  return Buffer.concat([prefix, Buffer.alloc(MOBILE_MAX_GAME_BYTES + 1 - prefix.byteLength, 0x78)]);
}

function cancellableSource(): Buffer {
  const prefix = Buffer.from('[Event "Cancelled add"]\n\n{');
  return Buffer.concat([prefix, Buffer.alloc(16 * 1024 * 1024, 0x78), Buffer.from("}\n")]);
}

async function phoneLayout(page: import("@playwright/test").Page): Promise<{
  horizontalOverflow: boolean;
  controlsOutsideViewport: boolean;
  controlOverlap: boolean;
  contentOverlap: boolean;
}> {
  return page.evaluate(() => {
    type Box = { left: number; right: number; top: number; bottom: number };
    const readBox = (element: Element): Box => {
      const { left, right, top, bottom } = element.getBoundingClientRect();
      return { left, right, top, bottom };
    };
    const overlaps = (left: Box, right: Box): boolean =>
      left.left < right.right - 0.5 && left.right > right.left + 0.5 &&
      left.top < right.bottom - 0.5 && left.bottom > right.top + 0.5;
    const controlBoxes = Array.from(document.querySelectorAll<HTMLElement>(".reader-control"))
      .map(readBox);
    const contentBoxes = [
      ".reader-header",
      ".board-wrap",
      ".mobile-notation",
      ".meta-panel",
      ".raw-source-drawer",
    ].flatMap((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      return element && !element.hidden ? [readBox(element)] : [];
    });

    return {
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      controlsOutsideViewport: controlBoxes.some(({ left, right }) => left < -0.5 || right > window.innerWidth + 0.5),
      controlOverlap: controlBoxes.some((left, index) => controlBoxes
        .slice(index + 1)
        .some((right) => overlaps(left, right))),
      contentOverlap: contentBoxes.some((left, index) => contentBoxes
        .slice(index + 1)
        .some((right) => overlaps(left, right))),
    };
  });
}
