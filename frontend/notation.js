// Variation-aware notation rendering.
//
// The document arrives as a flat id-addressed node array (nodes[0] = root,
// children[0] = main continuation, children[1..] = sidelines). Rendering
// walks each line iteratively; sideline blocks are emitted right after the
// mainline move they are alternatives to — standard PGN/RAV reading order:
//   1. e4 e5 (1... c5 {Sicilian}) 2. Nf3
//
// Comments become prose blocks that break the move flow (Chessable-style
// annotation-first reading), so a heavily annotated game reads as text with
// embedded moves rather than a raw token dump.
//
// Large documents are built in chunks across animation frames so the tab
// never freezes; the DOM is assembled in a detached fragment and attached
// once at the end.

const CHUNK_NODES = 1500;
const COLLAPSE_DEPTH = 3; // variations nested this deep start collapsed

export async function buildNotation(doc, { onSelect }) {
  const nodes = doc.nodes;
  const rootEl = document.createElement("div");
  rootEl.className = "notation-body";
  const nodeEls = new Map();
  let emitted = 0;

  async function maybeYield() {
    emitted++;
    if (emitted % CHUNK_NODES === 0) {
      await new Promise((r) => requestAnimationFrame(r));
    }
  }

  function moveToken(n) {
    const span = document.createElement("span");
    span.className = "mv";
    span.dataset.nodeId = n.id;
    span.addEventListener("click", () => onSelect(n.id));
    nodeEls.set(n.id, span);
    return span;
  }

  function fillToken(span, n, withNumber) {
    if (n.color === "w") {
      span.insertAdjacentHTML("beforeend", `<span class="mvnum">${n.moveNumber}.</span>`);
    } else if (withNumber) {
      span.insertAdjacentHTML("beforeend", `<span class="mvnum">${n.moveNumber}…</span>`);
    }
    span.appendChild(document.createTextNode(n.san));
    if (n.glyphs && n.glyphs.length) {
      const nag = document.createElement("span");
      nag.className = "nag";
      nag.textContent = n.glyphs.join("");
      span.appendChild(nag);
    }
  }

  function commentBlock(text, inline = false) {
    const el = document.createElement("span");
    el.className = inline ? "cmt inline" : "cmt";
    el.textContent = text;
    return el;
  }

  // Render the line starting at nodeId into container. Iterative along the
  // line; recursion only per nesting level (bounded by variation depth).
  async function renderLine(startId, container, depth) {
    let curId = startId;
    let needNumber = true;
    while (curId != null) {
      const n = nodes[curId];
      if (n.startingComment) {
        container.appendChild(commentBlock(n.startingComment, depth > 0));
        needNumber = true;
      }
      const tok = moveToken(n);
      fillToken(tok, n, needNumber);
      container.appendChild(tok);
      container.appendChild(document.createTextNode(" "));
      needNumber = false;
      if (n.comment) {
        container.appendChild(commentBlock(n.comment, depth > 0 && n.comment.length < 120));
        needNumber = true;
      }
      // Sidelines: alternatives to this move live on its parent.
      const parent = nodes[n.parentId];
      if (parent && parent.children[0] === n.id && parent.children.length > 1) {
        for (const altId of parent.children.slice(1)) {
          await renderVariation(altId, container, depth + 1);
        }
        needNumber = true;
      }
      await maybeYield();
      curId = n.children.length ? n.children[0] : null;
    }
  }

  async function renderVariation(startId, container, depth) {
    const block = document.createElement("span");
    block.className = "variation";
    if (depth >= COLLAPSE_DEPTH) block.classList.add("collapsed");

    const toggle = document.createElement("span");
    toggle.className = "var-toggle";
    toggle.textContent = block.classList.contains("collapsed") ? "+" : "−";
    toggle.title = "collapse/expand variation";
    toggle.addEventListener("click", () => {
      const collapsed = block.classList.toggle("collapsed");
      toggle.textContent = collapsed ? "+" : "−";
    });
    block.appendChild(toggle);

    const body = document.createElement("span");
    body.className = "var-body";
    block.appendChild(body);
    container.appendChild(block);
    await renderLine(startId, body, depth);
  }

  // Pre-game comment (intro prose) from the root node.
  if (nodes[0].comment) rootEl.appendChild(commentBlock(nodes[0].comment));
  if (nodes[0].children.length) {
    // Alternatives to the first move are emitted inside renderLine via the
    // parent-children check, like at any other branch point.
    await renderLine(nodes[0].children[0], rootEl, 0);
  } else {
    const note = document.createElement("div");
    note.className = "muted";
    note.textContent = "(no moves — header-only or annotation-only entry)";
    rootEl.appendChild(note);
  }
  const result = document.createElement("span");
  result.className = "result-token";
  result.textContent = doc.result || "";
  rootEl.appendChild(result);

  return { rootEl, nodeEls };
}

/** Expand any collapsed variation blocks containing `el` so it can be seen. */
export function revealToken(el) {
  let p = el.parentElement;
  while (p) {
    if (p.classList && p.classList.contains("collapsed")) {
      p.classList.remove("collapsed");
      const t = p.querySelector(":scope > .var-toggle");
      if (t) t.textContent = "−";
    }
    p = p.parentElement;
  }
}
