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

  const replacementDialog = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message()).toContain("first.pgn");
    await dialog.accept();
  });
  await page.locator("#source-input").setInputFiles({
    name: "replacement.pgn",
    mimeType: "application/x-chess-pgn",
    buffer: Buffer.from('[Event "Replacement"]\n[White "Two"]\n\n1. d4 *\n'),
  });
  await replacementDialog;

  await expect(page.locator("#source-status")).toHaveText("ready", { timeout: 10_000 });
  await expect(page.locator("#source-name")).toHaveText("replacement.pgn");
  await expect(page.locator("#record-list .game-record")).toHaveCount(1);
  await expect(page.locator("#record-list")).toContainText("Replacement");
  await expect(page.locator("#record-list")).not.toContainText("First");
  await expect(page.locator(".source-panel")).toHaveCount(1);
});

test("keeps the active source after a failed replacement and recovers on retry", async ({ page }) => {
  await page.goto("/");
  await page.locator("#source-input").setInputFiles({
    name: "active-source.pgn",
    mimeType: "application/x-chess-pgn",
    buffer: Buffer.from('[Event "Active"]\n[White "Kept"]\n\n1. e4 *\n'),
  });
  await expect(page.locator("#source-status")).toHaveText("ready", { timeout: 10_000 });

  const invalidReplacementDialog = page.waitForEvent("dialog").then((dialog) => dialog.accept());
  await page.locator("#source-input").setInputFiles({
    name: "not-a-pgn.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("replacement failed"),
  });
  await invalidReplacementDialog;
  await expect(page.locator("#source-error")).toContainText("ends in .pgn");
  await expect(page.locator("#source-name")).toHaveText("active-source.pgn");
  await expect(page.locator("#record-list .game-record")).toHaveCount(1);
  await expect(page.locator("#record-list")).toContainText("Kept");

  const recoveredReplacementDialog = page.waitForEvent("dialog").then((dialog) => dialog.accept());
  await page.locator("#source-input").setInputFiles({
    name: "recovered-source.pgn",
    mimeType: "application/x-chess-pgn",
    buffer: Buffer.from('[Event "Recovered"]\n[White "New source"]\n\n1. d4 *\n'),
  });
  await recoveredReplacementDialog;
  await expect(page.locator("#source-status")).toHaveText("ready", { timeout: 10_000 });
  await expect(page.locator("#source-name")).toHaveText("recovered-source.pgn");
  await expect(page.locator("#source-error")).toBeHidden();
  await expect(page.locator("#record-list .game-record")).toHaveCount(1);
  await expect(page.locator("#record-list")).toContainText("New source");
  await expect(page.locator("#record-list")).not.toContainText("Kept");
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

    const oversizedSourceDialog = page.waitForEvent("dialog").then((dialog) => dialog.accept());
    await page.locator("#source-input").setInputFiles(oversizedPath);
    await oversizedSourceDialog;
    await expect(page.locator("#source-error")).toContainText("50 MiB");
    await expect(page.locator("#source-status")).toHaveText("ready");
    await expect(page.locator("#source-name")).toHaveText("source-boundary.pgn");
    await expect(page.locator("#record-list .game-record")).toHaveCount(1);

    const oversizedGameDialog = page.waitForEvent("dialog").then((dialog) => dialog.accept());
    await page.locator("#source-input").setInputFiles(largeGamePath);
    await oversizedGameDialog;
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
