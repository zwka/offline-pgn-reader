// App shell: hash router + views (library, game list, reader).

import { api } from "./api.js";
import { createBoard, renderBoard } from "./board.js";
import { buildNotation, revealToken } from "./notation.js";

const app = document.getElementById("app");
const breadcrumb = document.getElementById("breadcrumb");
const healthDot = document.getElementById("health-dot");

let cleanupCurrentView = null;

// ------------------------------------------------------------------ utils

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

const fmtBytes = (n) => {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
};

function setBreadcrumb(...parts) {
  breadcrumb.textContent = "";
  parts.forEach((p, i) => {
    if (i > 0) breadcrumb.appendChild(document.createTextNode("  ›  "));
    breadcrumb.appendChild(p);
  });
}

function showError(err) {
  app.textContent = "";
  app.appendChild(
    h("div", { class: "loading error-text" }, `Error: ${err.message || err}`)
  );
}

// ------------------------------------------------------------------ health

async function pollHealth() {
  try {
    const st = await api.health();
    healthDot.className = `health-dot ${st.status === "ok" ? "ok" : "bad"}`;
    healthDot.title = `backend ${st.status} · v${st.version}`;
  } catch {
    healthDot.className = "health-dot bad";
    healthDot.title = "backend unreachable";
  }
}
setInterval(pollHealth, 10000);
pollHealth();

// ------------------------------------------------------------------ library view

async function libraryView() {
  setBreadcrumb(h("span", {}, "Library"));
  app.textContent = "";
  app.appendChild(h("div", { class: "loading" }, h("span", { class: "spinner" }), "Loading library…"));

  let pollTimer = null;
  let intakeError = null;
  const scanActionErrors = new Map();
  let renderedFiles = [];
  let renderedDiscovered = [];
  cleanupCurrentView = () => clearTimeout(pollTimer);

  async function refresh() {
    let files, discovered;
    try {
      [files, discovered] = await Promise.all([api.files(), api.discover()]);
    } catch (err) {
      showError(err);
      return;
    }
    render(files, discovered);
    if (files.some((f) => f.scan_status === "scanning")) {
      pollTimer = setTimeout(refresh, 700);
    }
  }

  async function registerSource(path, onSuccess = () => {}) {
    try {
      await api.registerFile(path);
      intakeError = null;
      onSuccess();
      await refresh();
    } catch (err) {
      intakeError = err instanceof Error ? err.message : String(err);
      render(renderedFiles, renderedDiscovered);
    }
  }

  function fileCard(f) {
    const status = !f.exists
      ? "missing"
      : f.scan_status === "error"
        ? "error"
        : f.scan_status === "scanning"
          ? "scanning"
          : f.stale
            ? "stale"
            : f.scan_status;
    const pct = f.progress && f.progress.bytesTotal
      ? Math.round((100 * f.progress.bytesDone) / f.progress.bytesTotal) : null;
    const scanActionError = scanActionErrors.get(f.id);
    return h(
      "div",
      { class: "file-card", onclick: () => (location.hash = `#/file/${f.id}`) },
      h("h3", {}, f.name),
      h(
        "div",
        { class: "file-meta" },
        h("span", { class: `badge ${status}` }, status),
        h("span", {}, fmtBytes(f.size)),
        f.scan_status === "ready" ? h("span", {}, `${f.game_count} games`) : null,
        f.warning_count > 0 ? h("span", { class: "warn-text" }, `${f.warning_count} ⚠`) : null,
        f.progress ? h("span", {}, `${f.progress.gamesFound} found…`) : null
      ),
      pct !== null
        ? h("div", { class: "progress-track" }, h("div", { class: "progress-fill", style: `width:${pct}%` }))
        : null,
      f.scan_error ? h("div", { class: "error-text", style: "font-size:12px;margin-top:6px" }, f.scan_error) : null,
      scanActionError ? h("div", { class: "error-text", role: "alert", style: "font-size:12px;margin-top:6px" }, scanActionError) : null,
      h(
        "div",
        { class: "file-actions" },
        h("button", {
          class: "ghost-btn",
          onclick: async (e) => {
            e.stopPropagation();
            try {
              await api.rescan(f.id);
              scanActionErrors.delete(f.id);
              await refresh();
            } catch (err) {
              scanActionErrors.set(f.id, err instanceof Error ? err.message : String(err));
              render(renderedFiles, renderedDiscovered);
            }
          },
        }, f.stale ? "Re-scan (changed)" : "Re-scan"),
        h("button", {
          class: "ghost-btn",
          onclick: async (e) => {
            e.stopPropagation();
            if (confirm(`Remove "${f.name}" from the index? The source file is not touched.`)) {
              await api.removeFile(f.id);
              refresh();
            }
          },
        }, "Remove")
      )
    );
  }

  function render(files, discovered) {
    renderedFiles = files;
    renderedDiscovered = discovered;
    const unregistered = discovered.filter((d) => !d.registered);
    app.textContent = "";
    app.appendChild(
      h(
        "div",
        {},
        h(
          "section",
          { class: "lib-section" },
          h("h2", {}, "Indexed PGN files"),
          files.length
            ? h("div", { class: "file-grid" }, files.map(fileCard))
            : h("div", { class: "empty-note" }, "No files indexed yet — add one below.")
        ),
        h(
          "section",
          { class: "lib-section" },
          h("h2", {}, "Add files"),
          intakeError ? h("div", { class: "error-text", role: "alert" }, intakeError) : null,
          h(
            "div",
            { class: "add-row" },
            h("input", { type: "text", id: "path-input", placeholder: "Absolute path to a .pgn file (e.g. /Users/you/games.pgn)" }),
            h("button", {
              class: "primary-btn",
              onclick: async () => {
                const input = document.getElementById("path-input");
                if (!input.value.trim()) return;
                await registerSource(input.value.trim(), () => { input.value = ""; });
              },
            }, "Index path"),
            h("label", { class: "ghost-btn", style: "cursor:pointer" },
              "Upload copy…",
              h("input", {
                type: "file", accept: ".pgn", style: "display:none",
                onchange: async (e) => {
                  const file = e.target.files[0];
                  if (!file) return;
                  try {
                    await api.uploadFile(file);
                    intakeError = null;
                    e.target.value = "";
                    await refresh();
                  } catch (err) {
                    intakeError = err instanceof Error ? err.message : String(err);
                    render(renderedFiles, renderedDiscovered);
                  }
                },
              })
            )
          ),
          unregistered.length
            ? h(
                "ul",
                { class: "discover-list" },
                unregistered.map((d) =>
                  h(
                    "li",
                    {},
                    h("span", {}, d.name),
                    h("span", { class: "path" }, d.path),
                    h("span", { class: "muted" }, fmtBytes(d.size)),
                    h("button", {
                      class: "ghost-btn",
                      onclick: async () => { await registerSource(d.path); },
                    }, "Index")
                  )
                )
              )
              : h("div", { class: "empty-note" }, "No unregistered PGN sources found.")
        )
      )
    );
  }

  refresh();
}

// ------------------------------------------------------------------ game list view

async function fileView(fileId) {
  app.textContent = "";
  app.appendChild(h("div", { class: "loading" }, h("span", { class: "spinner" }), "Loading games…"));

  let file;
  try {
    file = await api.file(fileId);
  } catch (err) { return showError(err); }

  setBreadcrumb(
    h("a", { href: "#/library" }, "Library"),
    h("span", {}, file.name)
  );

  const state = { q: "", offset: 0, limit: 100 };
  let searchTimer = null;
  cleanupCurrentView = () => clearTimeout(searchTimer);

  async function load() {
    let page;
    try {
      page = await api.games(fileId, state);
    } catch (err) { return showError(err); }
    render(page);
  }

  function render(page) {
    const from = page.total === 0 ? 0 : page.offset + 1;
    const to = Math.min(page.offset + page.limit, page.total);
    app.textContent = "";
    app.appendChild(
      h(
        "div",
        {},
        h("h2", {}, file.name, " ", h("span", { class: "muted" }, `· ${file.game_count} games`)),
        file.warning_count > 0
          ? h("div", { class: "warn-panel" },
              `${file.warning_count} game(s) were indexed with warnings (malformed records). They are readable but flagged with ⚠ below.`)
          : null,
        h(
          "div",
          { class: "toolbar", style: "margin-top:12px" },
          h("input", {
            type: "search", placeholder: "Filter by player, event, site, ECO, opening, date…",
            value: state.q,
            oninput: (e) => {
              clearTimeout(searchTimer);
              searchTimer = setTimeout(() => {
                state.q = e.target.value;
                state.offset = 0;
                load();
              }, 250);
            },
          }),
          h("span", { class: "muted" }, `${page.total} match${page.total === 1 ? "" : "es"}`)
        ),
        h(
          "table",
          { class: "games-table" },
          h("thead", {},
            h("tr", {},
              ...["#", "White", "Black", "Event", "Date", "Round", "Result", ""].map((c) => h("th", {}, c)))),
          h(
            "tbody",
            {},
            page.games.map((g) =>
              h(
                "tr",
                { onclick: () => (location.hash = `#/game/${g.id}`) },
                h("td", { class: "num" }, String(g.idx_in_file + 1)),
                h("td", {}, g.white || "—"),
                h("td", {}, g.black || "—"),
                h("td", {}, g.event === "?" ? "" : g.event),
                h("td", {}, g.date === "????.??.??" ? "" : g.date),
                h("td", {}, g.round === "?" ? "" : g.round),
                h("td", { class: "num" }, g.result),
                h("td", {}, g.warning ? h("span", { class: "warn-text", title: g.warning }, "⚠") : "")
              )
            )
          )
        ),
        h(
          "div",
          { class: "pager" },
          h("button", {
            class: "ghost-btn", disabled: page.offset === 0 ? "" : null,
            onclick: () => { state.offset = Math.max(0, state.offset - state.limit); load(); },
          }, "‹ Prev"),
          h("span", {}, `${from}–${to} of ${page.total}`),
          h("button", {
            class: "ghost-btn", disabled: to >= page.total ? "" : null,
            onclick: () => { state.offset += state.limit; load(); },
          }, "Next ›")
        )
      )
    );
  }

  load();
}

// ------------------------------------------------------------------ reader view

async function gameView(gameId) {
  app.textContent = "";
  app.appendChild(h("div", { class: "loading" }, h("span", { class: "spinner" }), "Loading game…"));

  let doc;
  try {
    doc = await api.game(gameId);
  } catch (err) { return showError(err); }

  const nodes = doc.nodes;
  const headers = Object.fromEntries(doc.headers);
  const title = [headers.White, headers.Black].filter((s) => s && s !== "?").join(" — ") || "Untitled game";

  setBreadcrumb(
    h("a", { href: "#/library" }, "Library"),
    h("a", { href: `#/file/${doc.fileId}` }, doc.fileName),
    h("span", {}, title)
  );

  // ---- layout skeleton
  const boardEl = h("div", {});
  const board = createBoard(boardEl);
  const caption = h("div", { class: "move-caption" });
  const notationPane = h("div", { class: "notation" },
    h("div", { class: "loading" }, h("span", { class: "spinner" }), "Rendering notation…"));
  const pgnPre = h("pre", { class: "hidden" });

  const navBtn = (label, title, fn) => h("button", { title, onclick: fn }, label);

  app.textContent = "";
  app.appendChild(
    h(
      "div",
      {},
      h(
        "div",
        { class: "reader-title" },
        h("h2", {}, title),
        h("span", { class: "result" }, doc.result),
        doc.warnings.length
          ? h("span", { class: "warn-text", title: doc.warnings.join("\n") }, `⚠ ${doc.warnings.length} parser warning(s)`)
          : null,
        h(
          "div",
          { class: "game-nav" },
          h("button", {
            class: "ghost-btn", disabled: doc.neighbors.prev == null ? "" : null,
            title: "previous game in file ( [ )",
            onclick: () => doc.neighbors.prev != null && (location.hash = `#/game/${doc.neighbors.prev}`),
          }, "‹ prev"),
          h("button", {
            class: "ghost-btn", disabled: doc.neighbors.next == null ? "" : null,
            title: "next game in file ( ] )",
            onclick: () => doc.neighbors.next != null && (location.hash = `#/game/${doc.neighbors.next}`),
          }, "next ›")
        )
      ),
      h(
        "div",
        { class: "reader" },
        h(
          "div",
          { class: "board-col" },
          h("div", { class: "board-wrap" },
            boardEl,
            h("div", { class: "board-controls" },
              navBtn("⏮", "start (Home)", () => selectNode(0)),
              navBtn("◀", "back (←)", stepBack),
              navBtn("▶", "forward (→)", stepForward),
              navBtn("⏭", "end of line (End)", toLineEnd),
              navBtn("⇅", "flip board (f)", flip)
            ),
            caption
          ),
          h("details", { class: "meta-panel" },
            h("summary", {}, "Game headers"),
            h("table", { class: "meta-table" },
              doc.headers.map(([k, v]) => h("tr", {}, h("td", {}, k), h("td", {}, v))))
          ),
          doc.warnings.length
            ? h("div", { class: "warn-panel" }, "Parser warnings:",
                h("ul", {}, doc.warnings.map((w) => h("li", {}, w))))
            : null,
          h("div", { class: "pgn-drawer" },
            h("button", { class: "ghost-btn", onclick: togglePgn }, "Raw PGN source (p)"),
            pgnPre)
        ),
        h("div", { class: "notation-col" }, notationPane)
      )
    )
  );

  // ---- notation
  const { rootEl, nodeEls } = await buildNotation(doc, { onSelect: selectNode });
  notationPane.textContent = "";
  notationPane.appendChild(rootEl);

  // ---- navigation state
  let currentId = 0;

  function selectNode(id) {
    const prevEl = nodeEls.get(currentId);
    if (prevEl) prevEl.classList.remove("current");
    currentId = id;
    const n = nodes[id];
    renderBoard(board, n.fen, n.uci, n);
    const el = nodeEls.get(id);
    if (el) {
      el.classList.add("current");
      revealToken(el);
      el.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
    if (n.san) {
      const num = n.color === "w" ? `${n.moveNumber}.` : `${n.moveNumber}…`;
      caption.textContent = `${num} ${n.san}${(n.glyphs || []).join("")}  ·  ply ${n.ply}`;
    } else {
      caption.textContent = "start position";
    }
  }

  function stepForward() {
    const n = nodes[currentId];
    if (n.children.length) selectNode(n.children[0]);
  }
  function stepBack() {
    const n = nodes[currentId];
    if (n.parentId != null) selectNode(n.parentId);
  }
  function toLineEnd() {
    let n = nodes[currentId];
    while (n.children.length) n = nodes[n.children[0]];
    selectNode(n.id);
  }
  function cycleSibling(dir) {
    const n = nodes[currentId];
    if (n.parentId == null) return;
    const sibs = nodes[n.parentId].children;
    if (sibs.length < 2) return;
    const idx = sibs.indexOf(n.id);
    selectNode(sibs[(idx + dir + sibs.length) % sibs.length]);
  }
  function flip() {
    board.flipped = !board.flipped;
    const n = nodes[currentId];
    renderBoard(board, n.fen, n.uci, n);
  }
  let pgnLoaded = false;
  async function togglePgn() {
    if (!pgnLoaded) {
      pgnPre.textContent = await api.gamePgn(gameId);
      pgnLoaded = true;
    }
    pgnPre.classList.toggle("hidden");
  }

  function onKey(e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    const actions = {
      ArrowRight: stepForward,
      ArrowLeft: stepBack,
      ArrowDown: () => cycleSibling(1),
      ArrowUp: () => cycleSibling(-1),
      Home: () => selectNode(0),
      End: toLineEnd,
      f: flip,
      p: togglePgn,
      "]": () => doc.neighbors.next != null && (location.hash = `#/game/${doc.neighbors.next}`),
      "[": () => doc.neighbors.prev != null && (location.hash = `#/game/${doc.neighbors.prev}`),
    };
    const fn = actions[e.key];
    if (fn) { e.preventDefault(); fn(); }
  }
  document.addEventListener("keydown", onKey);
  cleanupCurrentView = () => document.removeEventListener("keydown", onKey);

  selectNode(0);
}

// ------------------------------------------------------------------ router

function route() {
  if (cleanupCurrentView) { cleanupCurrentView(); cleanupCurrentView = null; }
  const hash = location.hash || "#/library";
  const mFile = hash.match(/^#\/file\/(\d+)$/);
  const mGame = hash.match(/^#\/game\/(\d+)$/);
  if (mFile) fileView(+mFile[1]);
  else if (mGame) gameView(+mGame[1]);
  else libraryView();
}

window.addEventListener("hashchange", route);
route();

// help overlay
document.getElementById("help-btn").addEventListener("click", () =>
  document.getElementById("help-overlay").classList.remove("hidden"));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.getElementById("help-overlay").classList.add("hidden");
});
