import {
  InMemoryMobileLibrary,
  MOBILE_PAGE_SIZE,
  type MobileLibrary,
  type MobileGameRecord,
  type MobileScanWorker,
  type MobileSourceRecord,
} from "./library.js";

const sourceName = getElement<HTMLElement>("source-name");
const sourceStatus = getElement<HTMLElement>("source-status");
const sourceSize = getElement<HTMLElement>("source-size");
const gameCount = getElement<HTMLElement>("game-count");
const warningCount = getElement<HTMLElement>("warning-count");
const scanProgress = getElement<HTMLProgressElement>("scan-progress");
const progressLabel = getElement<HTMLElement>("scan-progress-label");
const sourceError = getElement<HTMLElement>("source-error");
const sourceInput = getElement<HTMLInputElement>("source-input");
const searchInput = getElement<HTMLInputElement>("metadata-search");
const recordList = getElement<HTMLElement>("record-list");
const listSummary = getElement<HTMLElement>("list-summary");
const previousPage = getElement<HTMLButtonElement>("previous-page");
const nextPage = getElement<HTMLButtonElement>("next-page");

const library: MobileLibrary = new InMemoryMobileLibrary(() =>
  new Worker(new URL("./scan-worker.js", import.meta.url), { type: "module" }) as unknown as MobileScanWorker,
);

let query = "";
let offset = 0;

sourceInput.addEventListener("change", () => {
  const file = sourceInput.files?.[0];
  if (!file) return;
  query = "";
  offset = 0;
  searchInput.value = "";
  library.replaceSource({ name: file.name, blob: file });
  sourceInput.value = "";
});

searchInput.addEventListener("input", () => {
  query = searchInput.value;
  offset = 0;
  renderGames();
});

previousPage.addEventListener("click", () => {
  offset = Math.max(0, offset - MOBILE_PAGE_SIZE);
  renderGames();
});

nextPage.addEventListener("click", () => {
  offset += MOBILE_PAGE_SIZE;
  renderGames();
});

library.subscribe(() => {
  renderSource(library.source);
  renderGames();
});

window.addEventListener("beforeunload", () => library.close());
renderSource(library.source);
renderGames();

function renderSource(source: MobileSourceRecord | null): void {
  sourceName.textContent = source?.name ?? "No PGN source selected";
  sourceStatus.textContent = source?.scan_status ?? "idle";
  sourceStatus.className = `status status-${source?.scan_status ?? "idle"}`;
  sourceSize.textContent = source ? formatBytes(source.size) : "-";
  gameCount.textContent = source ? String(source.game_count) : "0";
  warningCount.textContent = source && source.warning_count > 0
    ? `${source.warning_count} warning${source.warning_count === 1 ? "" : "s"}`
    : "No warnings";
  sourceError.hidden = !source?.scan_error;
  sourceError.textContent = source?.scan_error ?? "";

  const progress = source?.progress;
  scanProgress.hidden = !source;
  scanProgress.max = Math.max(1, progress?.bytesTotal ?? source?.size ?? 1);
  scanProgress.value = Math.min(progress?.bytesDone ?? 0, scanProgress.max);
  progressLabel.textContent = progressText(source);
}

function renderGames(): void {
  let page = library.listGames(query, offset, MOBILE_PAGE_SIZE);
  if (page.total > 0 && page.offset >= page.total) {
    offset = Math.floor((page.total - 1) / page.limit) * page.limit;
    page = library.listGames(query, offset, MOBILE_PAGE_SIZE);
  }

  recordList.replaceChildren(...page.games.map(renderGame));
  const from = page.total === 0 ? 0 : page.offset + 1;
  const to = Math.min(page.offset + page.limit, page.total);
  listSummary.textContent = page.total === 0
    ? query ? "No matching Game records" : "No Game records"
    : `${from}-${to} of ${page.total}`;
  previousPage.disabled = page.offset === 0;
  nextPage.disabled = to >= page.total;
}

function renderGame(game: MobileGameRecord): HTMLElement {
  const record = document.createElement("article");
  record.className = "game-record";
  record.dataset.index = String(game.idx_in_file);
  record.append(
    labeledValue("Game", String(game.idx_in_file + 1), "record-number"),
    players(game.white, game.black),
    labeledValue("Result", game.result || "*", "record-result"),
    metadataGrid(game),
  );
  return record;
}

function players(white: string, black: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "players";
  const whiteName = document.createElement("strong");
  whiteName.textContent = white || "Unknown White";
  const separator = document.createElement("span");
  separator.textContent = "vs";
  const blackName = document.createElement("strong");
  blackName.textContent = black || "Unknown Black";
  wrapper.append(whiteName, separator, blackName);
  return wrapper;
}

function metadataGrid(game: MobileGameRecord): HTMLElement {
  const grid = document.createElement("dl");
  grid.className = "metadata-grid";
  for (const [label, value] of [
    ["Event", game.event],
    ["Site", game.site],
    ["Date", game.date],
    ["Round", game.round],
    ["ECO", game.eco],
    ["Opening", game.opening],
  ] as const) {
    grid.append(labeledValue(label, value || "-"));
  }
  return grid;
}

function labeledValue(label: string, value: string, className = ""): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = className;
  const term = document.createElement("dt");
  term.textContent = label;
  const description = document.createElement("dd");
  description.textContent = value;
  wrapper.append(term, description);
  return wrapper;
}

function progressText(source: MobileSourceRecord | null): string {
  if (!source) return "Choose a local PGN source to begin.";
  if (source.scan_status === "error") return "Scan failed.";
  if (source.scan_status === "ready") return "Scan complete.";
  const progress = source.progress;
  if (!progress || progress.bytesTotal === 0) return "Scanning source...";
  const percent = Math.round((100 * progress.bytesDone) / progress.bytesTotal);
  return `Scanning source... ${percent}% (${progress.gamesFound} found)`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`mobile shell is missing #${id}`);
  return element as T;
}
