import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const requiredCachedAssets = [
  "/index.html",
  "/mobile.css",
  "/manifest.webmanifest",
  "/service-worker.js",
  "/dist/mobile/app.js",
  "/dist/mobile/scan-worker.js",
  "/dist/vendor/chess.js",
  "/dist/vendor/pgn.js",
  "/pieces/wK.svg",
  "/pieces/bK.svg",
  "/icons/icon-180.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

test("publishes install metadata and precaches the complete mobile build", async ({ page }) => {
  const manifestResponse = await page.request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBe(true);
  expect(manifestResponse.headers()["content-type"]).toMatch(/json/);
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({
    name: "PGN Reader Mobile",
    short_name: "PGN Reader",
    start_url: "./",
    scope: "./",
    display: "standalone",
    theme_color: "#18211f",
    background_color: "#f3f6f2",
  });
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ src: "./icons/icon-192.png", sizes: "192x192", type: "image/png" }),
    expect.objectContaining({ src: "./icons/icon-512.png", sizes: "512x512", type: "image/png" }),
  ]));

  const workerResponse = await page.request.get("/service-worker.js");
  expect(workerResponse.ok()).toBe(true);
  const workerSource = await workerResponse.text();
  expect(workerSource).toContain('const CACHE_NAME = "offline-pgn-reader-mobile-v1"');
  expect(workerSource).toContain("self.skipWaiting()");
  expect(workerSource).toContain("self.clients.claim()");
  expect(workerSource).toContain("caches.delete(key)");
  expect(workerSource).not.toContain("indexedDB");
  for (const asset of requiredCachedAssets.slice(1)) {
    expect(workerSource).toContain(`".${asset}"`);
  }

  await page.goto("/");
  await waitForControlledServiceWorker(page);
  const cacheState = await page.evaluate(async () => {
    const names = await caches.keys();
    const name = names.find((candidate) => candidate.startsWith("offline-pgn-reader-mobile-"));
    if (!name) throw new Error("mobile precache was not installed");
    const requests = await (await caches.open(name)).keys();
    return {
      name,
      paths: requests.map((request) => new URL(request.url).pathname),
    };
  });
  expect(cacheState.name).toBe("offline-pgn-reader-mobile-v1");
  expect(cacheState.paths).toEqual(expect.arrayContaining(requiredCachedAssets));
});

test("restores the persisted reader with network disabled", async ({ page }) => {
  const pageErrors: string[] = [];
  const blockedRequests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await waitForControlledServiceWorker(page);
  await page.locator("#source-input").setInputFiles({
    name: "offline-reader.pgn",
    mimeType: "application/x-chess-pgn",
    buffer: mobileReaderSource(),
  });
  await expect(page.locator("#source-status")).toHaveText("ready", { timeout: 10_000 });
  await expect(page.locator("#record-list .game-record")).toHaveCount(4);

  await page.context().setOffline(true);
  await page.route("**/*", (route) => {
    blockedRequests.push(route.request().url());
    return route.abort();
  });
  try {
    await page.reload();
    await expect(page.locator("#source-status")).toHaveText("ready", { timeout: 10_000 });
    await expect(page.locator("#source-name")).toHaveText("offline-reader.pgn");
    await expect(page.locator("#record-list .game-record")).toHaveCount(4);

    await page.locator("#record-list .game-record").first().click();
    await expect(page.locator(".reader-title")).toContainText("Annotator");
    await expect(page.locator('.board .sq[data-square="e2"] .piece')).toHaveAttribute("alt", "P");
    await expect(page.locator(".notation-body .cmt").first()).toContainText("Pre-game introduction comment.");
    await expect(page.locator(".notation-body .mv").filter({ hasText: "e4" }).first()).toContainText("!");

    await page.locator(".meta-panel summary").click();
    await expect(page.locator(".meta-table")).toContainText("Annotator");
    await page.getByRole("button", { name: "Raw PGN source" }).click();
    await expect(page.locator(".raw-source")).toContainText('[Event "Annotated"]');

    await page.locator('[data-action="next-game"]').click();
    await expect(page.locator(".reader-title")).toContainText("Arrows");
    await expect(page.locator('.board .sq[data-square="d4"] .csl')).toHaveCount(1);
    await expect(page.locator(".variation .mv").first()).toContainText("c5");
    await page.locator(".variation .mv").first().click();
    await expect(page.locator(".notation-body .mv.current")).toContainText("c5");

    await page.locator('[data-action="next-game"]').click();
    await expect(page.locator(".reader-title")).toContainText("Tree - Builder");
    expect(await page.locator(".variation").count()).toBeGreaterThan(0);
  } finally {
    await page.unroute("**/*");
    await page.context().setOffline(false);
  }

  expect(blockedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("keeps an empty Mobile Library usable offline", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await waitForControlledServiceWorker(page);
  await page.context().setOffline(true);
  try {
    await page.reload();
    await expect(page.locator("#source-status")).toHaveText("idle");
    await expect(page.locator("#source-name")).toHaveText("No PGN source selected");
    await expect(page.locator("#record-list .game-record")).toHaveCount(0);
    await expect(page.locator("#source-error")).toBeHidden();
  } finally {
    await page.context().setOffline(false);
  }

  expect(pageErrors).toEqual([]);
});

async function waitForControlledServiceWorker(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
}

function mobileReaderSource(): Buffer {
  return Buffer.from([
    readFileSync(resolve("tests/fixtures/annotations.pgn"), "utf8").trimEnd(),
    readFileSync(resolve("tests/fixtures/graphics.pgn"), "utf8").trimEnd(),
    readFileSync(resolve("tests/fixtures/variations.pgn"), "utf8").trimEnd(),
    readFileSync(resolve("tests/fixtures/fen_start.pgn"), "utf8").trimEnd(),
  ].join("\n\n"));
}
