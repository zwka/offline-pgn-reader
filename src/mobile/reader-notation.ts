import type { GameDocument, GameNode } from "../wire.js";

const CHUNK_NODES = 750;
const COLLAPSE_DEPTH = 3;

export type MobileNotation = {
  rootEl: HTMLElement;
  nodeEls: Map<number, HTMLSpanElement>;
};

export async function buildNotation(
  doc: GameDocument,
  onSelect: (id: number) => void,
): Promise<MobileNotation> {
  const nodes = doc.nodes;
  const rootEl = document.createElement("div");
  rootEl.className = "notation-body";
  const nodeEls = new Map<number, HTMLSpanElement>();
  let emitted = 0;

  async function maybeYield(): Promise<void> {
    emitted += 1;
    if (emitted % CHUNK_NODES !== 0) return;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }

  function moveToken(node: GameNode): HTMLSpanElement {
    const token = document.createElement("span");
    token.className = "mv";
    token.dataset.nodeId = String(node.id);
    token.setAttribute("role", "button");
    token.tabIndex = 0;
    token.addEventListener("click", () => onSelect(node.id));
    token.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onSelect(node.id);
    });
    nodeEls.set(node.id, token);
    return token;
  }

  function fillToken(token: HTMLSpanElement, node: GameNode, withNumber: boolean): void {
    if (node.color === "w") {
      token.appendChild(moveNumber(`${node.moveNumber}.`));
    } else if (withNumber) {
      token.appendChild(moveNumber(`${node.moveNumber}…`));
    }
    token.appendChild(document.createTextNode(node.san ?? ""));
    if (node.glyphs.length > 0) {
      const nag = document.createElement("span");
      nag.className = "nag";
      nag.textContent = node.glyphs.join("");
      token.appendChild(nag);
    }
  }

  function moveNumber(value: string): HTMLSpanElement {
    const number = document.createElement("span");
    number.className = "mvnum";
    number.textContent = value;
    return number;
  }

  function commentBlock(text: string, inline = false): HTMLSpanElement {
    const comment = document.createElement("span");
    comment.className = inline ? "cmt inline" : "cmt";
    comment.textContent = text;
    return comment;
  }

  async function renderLine(
    startId: number | null,
    container: HTMLElement,
    depth: number,
  ): Promise<void> {
    let currentId = startId;
    let needNumber = true;
    while (currentId != null) {
      const node = nodes[currentId];
      if (node.startingComment) {
        container.appendChild(commentBlock(node.startingComment, depth > 0));
        needNumber = true;
      }

      const token = moveToken(node);
      fillToken(token, node, needNumber);
      container.append(token, document.createTextNode(" "));
      needNumber = false;
      if (node.comment) {
        container.appendChild(commentBlock(node.comment, depth > 0 && node.comment.length < 120));
        needNumber = true;
      }

      const parent = node.parentId == null ? null : nodes[node.parentId];
      if (parent && parent.children[0] === node.id && parent.children.length > 1) {
        for (const alternateId of parent.children.slice(1)) {
          await renderVariation(alternateId, container, depth + 1);
        }
        needNumber = true;
      }

      await maybeYield();
      currentId = node.children.length > 0 ? node.children[0] : null;
    }
  }

  async function renderVariation(
    startId: number,
    container: HTMLElement,
    depth: number,
  ): Promise<void> {
    const variation = document.createElement("span");
    variation.className = "variation";
    if (depth >= COLLAPSE_DEPTH) variation.classList.add("collapsed");

    const toggle = document.createElement("button");
    toggle.className = "var-toggle";
    toggle.type = "button";
    toggle.setAttribute("aria-label", "Collapse variation");
    toggle.textContent = variation.classList.contains("collapsed") ? "+" : "-";
    toggle.addEventListener("click", () => {
      const collapsed = variation.classList.toggle("collapsed");
      toggle.textContent = collapsed ? "+" : "-";
      toggle.setAttribute("aria-label", collapsed ? "Expand variation" : "Collapse variation");
    });
    variation.appendChild(toggle);

    const body = document.createElement("span");
    body.className = "var-body";
    variation.appendChild(body);
    container.appendChild(variation);
    await renderLine(startId, body, depth);
  }

  const root = nodes[doc.rootId];
  if (root.comment) rootEl.appendChild(commentBlock(root.comment));
  if (root.children.length > 0) {
    await renderLine(root.children[0], rootEl, 0);
  } else {
    const note = document.createElement("div");
    note.className = "muted";
    note.textContent = "(no moves - header-only or annotation-only entry)";
    rootEl.appendChild(note);
  }

  const result = document.createElement("span");
  result.className = "result-token";
  result.textContent = doc.result || "";
  rootEl.appendChild(result);
  return { rootEl, nodeEls };
}

export function revealToken(element: HTMLElement): void {
  let parent = element.parentElement;
  while (parent) {
    if (parent.classList.contains("collapsed")) {
      parent.classList.remove("collapsed");
      const toggle = parent.querySelector<HTMLButtonElement>(":scope > .var-toggle");
      if (toggle) {
        toggle.textContent = "-";
        toggle.setAttribute("aria-label", "Collapse variation");
      }
    }
    parent = parent.parentElement;
  }
}
