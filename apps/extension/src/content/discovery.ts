// Element discovery for the crawl engine (FR-EX-020, FR-EX-022).
// Scans the DOM (including open shadow roots) for candidate clickable elements,
// de-duplicates them, and — by default — keeps only interactable ones
// (FR-EX-021). This only FINDS elements; it never clicks.

import { isInteractable } from "./visibility";

export interface ElementDescriptor {
  tag: string;
  role: string | null;
  text: string;
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
}

export interface DiscoveredElement extends ElementDescriptor {
  element: Element;
}

const CANDIDATE_SELECTOR = [
  "a[href]",
  "button",
  "input[type=submit]",
  "input[type=button]",
  "input[type=image]",
  "[role=button]",
  "[role=link]",
  "[role=tab]",
  "[role=menuitem]",
  "[onclick]",
].join(",");

export interface DiscoverOptions {
  root?: ParentNode;
  /** Include the computed-cursor:pointer heuristic (default true). */
  cursorHeuristic?: boolean;
  /** Keep only interactable elements per FR-EX-021 (default true). */
  filterVisible?: boolean;
}

export function discoverClickables(opts: DiscoverOptions = {}): DiscoveredElement[] {
  const root = opts.root ?? document;
  const cursorHeuristic = opts.cursorHeuristic ?? true;
  const filterVisible = opts.filterVisible ?? true;

  // "strong" = a real interactive element (matched CANDIDATE_SELECTOR).
  // "weak"   = clickable only via the cursor:pointer heuristic.
  const strong = new Set<Element>();
  const weak = new Set<Element>();
  collectCandidates(root, strong, weak, cursorHeuristic);

  // Collapse nested click targets (FR-EX-020 "de-duplicated per state"): a weak
  // element inside another clickable is almost always INHERITED cursor — the
  // button's own text or an inner wrapper. A user clicks the outer control, not
  // the text, so drop those. Strong controls are always kept, even when nested,
  // so a real button inside a clickable card is never lost.
  const all = new Set<Element>([...strong, ...weak]);
  const targets: Element[] = [];
  for (const el of strong) targets.push(el);
  for (const el of weak) {
    if (!hasCandidateAncestor(el, all)) targets.push(el);
  }

  const results: DiscoveredElement[] = [];
  for (const el of targets) {
    if (filterVisible && !isInteractable(el)) continue;
    results.push(describe(el));
  }
  return results;
}

function collectCandidates(
  root: ParentNode,
  strong: Set<Element>,
  weak: Set<Element>,
  cursorHeuristic: boolean,
): void {
  for (const el of Array.from(root.querySelectorAll(CANDIDATE_SELECTOR))) {
    strong.add(el);
  }
  // One pass over all elements: cursor heuristic + shadow-root recursion.
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (cursorHeuristic && !strong.has(el) && cursorIsPointer(el)) weak.add(el);
    const shadow = (el as HTMLElement).shadowRoot;
    if (shadow) collectCandidates(shadow, strong, weak, cursorHeuristic);
  }
}

/** Does `el` have an ancestor that is itself a discovered candidate? */
function hasCandidateAncestor(el: Element, set: Set<Element>): boolean {
  let parent = el.parentElement;
  while (parent) {
    if (set.has(parent)) return true;
    parent = parent.parentElement;
  }
  return false;
}

function cursorIsPointer(el: Element): boolean {
  try {
    return getComputedStyle(el).cursor === "pointer";
  } catch {
    return false;
  }
}

// ── descriptor building ──────────────────────────────────────────────

const IMPLICIT_ROLE: Record<string, string> = {
  a: "link",
  button: "button",
  input: "button",
};

function describe(el: Element): DiscoveredElement {
  const r = el.getBoundingClientRect();
  return {
    element: el,
    tag: el.tagName.toLowerCase(),
    role: getRole(el),
    text: accessibleText(el),
    selector: buildSelector(el),
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
  };
}

function getRole(el: Element): string | null {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  return IMPLICIT_ROLE[el.tagName.toLowerCase()] ?? null;
}

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 120);
}

function accessibleText(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return norm(aria);
  const title = el.getAttribute("title");
  if (title) return norm(title);
  if (el.tagName === "INPUT") {
    const value = (el as HTMLInputElement).value;
    if (value) return norm(value);
  }
  return norm(el.textContent ?? "");
}

/** Best-effort stable selector (prefers id / data-testid / aria-label). A full
 *  robust fingerprint comes later in FR-EX-024. */
function buildSelector(el: Element): string {
  if (el.id) return `#${cssEscape(el.id)}`;
  const testId = el.getAttribute("data-testid");
  if (testId) return `[data-testid="${escapeAttr(testId)}"]`;
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return `${el.tagName.toLowerCase()}[aria-label="${escapeAttr(ariaLabel)}"]`;
  return structuralPath(el);
}

function structuralPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && depth < 4) {
    const current: Element = node;
    if (current.id) {
      parts.unshift(`#${cssEscape(current.id)}`);
      break;
    }
    let part = current.tagName.toLowerCase();
    const parent = current.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === current.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    node = current.parentElement;
    depth++;
  }
  return parts.join(" > ");
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}
function escapeAttr(s: string): string {
  return s.replace(/"/g, '\\"');
}
