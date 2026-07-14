// Self-contained functions injected into the target page via
// chrome.scripting.executeScript({ func }). Each MUST be self-contained (no
// imports, all helpers nested) because executeScript serializes the function
// body. The canonical, unit-tested discovery/safety logic lives in
// discovery.ts / visibility.ts / safety.ts — this file mirrors it for injection.
//
// These are the page-side primitives of the crawl loop:
//   discoverCandidates → clickCandidate (FR-EX-031) → waitForStable (FR-EX-032)
// The orchestration that drives them lives in lib/crawl.ts (popup side).

/** A serializable descriptor of one clickable target on the page. */
export interface InjectedCandidate {
  idx: number;
  tag: string;
  role: string | null;
  text: string;
  href: string | null;
  destructive: boolean;
  /** Stable-ish fingerprint for the visited set (FR-EX-041 spirit). */
  key: string;
  /** Structural locator, reused as the trigger descriptor's selector (FR-EX-054). */
  selector: string;
}

export interface DiscoverResult {
  url: string;
  origin: string;
  candidates: InjectedCandidate[];
}

// FR-EX-020/021/022/070 — find clickable, interactable targets and tag each with
// a data-sc-idx attribute so clickCandidate can re-select the exact element.
export function discoverCandidates(opts: { blocklist: string[] }): DiscoverResult {
  const CANDIDATE =
    "a[href],button,input[type=submit],input[type=button],input[type=image]," +
    "[role=button],[role=link],[role=tab],[role=menuitem],[onclick]";

  document.querySelectorAll("[data-sc-idx]").forEach((n) => n.removeAttribute("data-sc-idx"));

  const strong = new Set<Element>();
  document.querySelectorAll(CANDIDATE).forEach((el) => strong.add(el));
  const weak = new Set<Element>();
  document.querySelectorAll("*").forEach((el) => {
    if (!strong.has(el) && getComputedStyle(el).cursor === "pointer") weak.add(el);
  });
  const all = new Set<Element>([...strong, ...weak]);

  function hasClickableAncestor(el: Element): boolean {
    let p = el.parentElement;
    while (p) {
      if (all.has(p)) return true;
      p = p.parentElement;
    }
    return false;
  }
  const targets: Element[] = [];
  strong.forEach((el) => targets.push(el));
  weak.forEach((el) => {
    if (!hasClickableAncestor(el)) targets.push(el);
  });

  function interactable(el: Element): boolean {
    if (!el.isConnected) return false;
    if ((el as HTMLButtonElement).disabled) return false;
    if (el.getAttribute("aria-disabled") === "true") return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Safety check (FR-EX-070) — whole-word match, mirrors safety.ts.
  const needles = opts.blocklist
    .map((s) => s.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);
  function isDestructive(el: Element): boolean {
    if (needles.length === 0) return false;
    const texts: string[] = [];
    const aria = el.getAttribute("aria-label");
    if (aria) texts.push(aria);
    const title = el.getAttribute("title");
    if (title) texts.push(title);
    if (el.tagName === "INPUT") {
      const v = (el as HTMLInputElement).value;
      if (v) texts.push(v);
    }
    if (el.textContent) texts.push(el.textContent);
    for (const raw of texts) {
      const text = raw.replace(/\s+/g, " ").trim().toLowerCase();
      for (const needle of needles) {
        if (text === needle) return true;
        const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`(^|\\W)${escaped}(\\W|$)`).test(text)) return true;
      }
    }
    return false;
  }

  // A stable structural locator (tag + nth-of-tag, up to 6 levels) so that
  // structurally-identical siblings (table rows, cards) get DISTINCT keys and
  // each is expanded — while staying stable across a state restore. NOT the
  // volatile data-sc-idx, which is reassigned on every discovery.
  function positionPath(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      let nth = 1;
      let sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === node.tagName) nth++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(`${node.tagName.toLowerCase()}:${nth}`);
      node = node.parentElement;
      depth++;
    }
    return parts.join(">");
  }

  const candidates: InjectedCandidate[] = [];
  let idx = 0;
  for (const el of targets) {
    if (!interactable(el)) continue;
    (el as HTMLElement).setAttribute("data-sc-idx", String(idx));
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const href = (el as HTMLAnchorElement).href || null;
    const destructive = isDestructive(el);
    const selector = positionPath(el);
    const key = `${tag}|${role || ""}|${text}|${href || ""}|${selector}`;
    candidates.push({ idx, tag, role, text, href, destructive, key, selector });
    idx++;
  }
  return { url: location.href, origin: location.origin, candidates };
}

// FR-EX-031 — safeClick: scroll into view, dispatch hover then a trusted-like
// pointerdown/pointerup/click sequence at the element centre. Refuses links that
// leave the project's allowedDomains (FR-EX-010/071) and neutralises new-tab
// targets (FR-EX-072). Self-contained; `allowedDomains` [] ⇒ no restriction.
export function clickCandidate(opts: { idx: number; allowedDomains: string[] }): {
  ok: boolean;
  reason?: string;
} {
  const el = document.querySelector(`[data-sc-idx="${opts.idx}"]`) as HTMLElement | null;
  if (!el || !el.isConnected) return { ok: false, reason: "gone" };

  const domains = opts.allowedDomains || [];
  const inScope = (host: string): boolean => {
    if (domains.length === 0) return true;
    const h = host.toLowerCase().replace(/\.$/, "");
    return domains.some((d) => {
      const dd = d.trim().toLowerCase().replace(/^\.+/, "").replace(/\.$/, "");
      return dd !== "" && (h === dd || h.endsWith(`.${dd}`));
    });
  };

  const href = (el as HTMLAnchorElement).href;
  if (href) {
    try {
      const u = new URL(href, location.href);
      if ((u.protocol === "http:" || u.protocol === "https:") && !inScope(u.hostname)) {
        return { ok: false, reason: "off-scope" };
      }
    } catch {
      /* non-navigational href (javascript:, #…) — allow */
    }
  }
  if (el.getAttribute("target")) el.setAttribute("target", "_self");

  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const mouse: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: cx,
    clientY: cy,
    button: 0,
  };
  const pointer: PointerEventInit = { ...mouse, pointerId: 1, pointerType: "mouse", isPrimary: true };
  try {
    el.dispatchEvent(new PointerEvent("pointerover", pointer));
    el.dispatchEvent(new PointerEvent("pointerenter", pointer));
    el.dispatchEvent(new MouseEvent("mouseover", mouse));
    el.dispatchEvent(new PointerEvent("pointerdown", pointer));
    el.dispatchEvent(new MouseEvent("mousedown", mouse));
    el.dispatchEvent(new PointerEvent("pointerup", pointer));
    el.dispatchEvent(new MouseEvent("mouseup", mouse));
    el.dispatchEvent(new MouseEvent("click", mouse));
  } catch {
    return { ok: false, reason: "dispatch" };
  }
  return { ok: true };
}

// FR-EX-032 (MAIN world) — install idempotent monkey-patches on window.fetch and
// XMLHttpRequest that keep an in-flight request counter on window.__scInflight and
// notify window.__scOnNetChange on every change. Must run in the page's MAIN world
// (that's where the app's fetch/XHR live) and be re-installed after every full
// navigation (a page load wipes it). No chrome.* usage — pure page code.
export function installNetworkCounter(opts: { allowedDomains: string[] }): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (w.__scNetPatched) return;
  w.__scNetPatched = true;
  w.__scInflight = 0;

  const bump = (delta: number): void => {
    w.__scInflight = Math.max(0, (w.__scInflight || 0) + delta);
    if (typeof w.__scOnNetChange === "function") {
      try {
        w.__scOnNetChange();
      } catch {
        /* ignore listener errors */
      }
    }
  };

  const origFetch = w.fetch;
  if (typeof origFetch === "function") {
    w.fetch = function (this: unknown, ...args: unknown[]) {
      bump(1);
      let p: Promise<unknown>;
      try {
        p = Promise.resolve(origFetch.apply(this, args));
      } catch (e) {
        bump(-1);
        throw e;
      }
      return p.finally(() => bump(-1));
    };
  }

  const XHR = w.XMLHttpRequest;
  if (XHR && XHR.prototype && typeof XHR.prototype.send === "function") {
    const origSend = XHR.prototype.send;
    XHR.prototype.send = function (this: XMLHttpRequest, ...args: unknown[]) {
      let counted = true;
      bump(1);
      const done = (): void => {
        if (!counted) return;
        counted = false;
        bump(-1);
      };
      try {
        this.addEventListener("loadend", done);
      } catch {
        done();
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return origSend.apply(this, args as any);
      } catch (e) {
        done(); // send() threw synchronously → balance the counter (never leak)
        throw e;
      }
    };
  }

  // FR-EX-072 — neutralise window.open: follow IN-SCOPE navigations in-tab (where
  // the scope guards can act) and block everything else (return null). Must be in
  // MAIN world; the isolated-world clickCandidate cannot override window.open.
  const domains = opts.allowedDomains || [];
  const openInScope = (host: string): boolean => {
    if (domains.length === 0) return true;
    const h = host.toLowerCase().replace(/\.$/, "");
    return domains.some((d) => {
      const dd = d.trim().toLowerCase().replace(/^\.+/, "").replace(/\.$/, "");
      return dd !== "" && (h === dd || h.endsWith(`.${dd}`));
    });
  };
  w.open = function (url?: unknown): null {
    try {
      if (url) {
        const u = new URL(String(url), location.href);
        const ok =
          u.protocol === "http:" || u.protocol === "https:"
            ? openInScope(u.hostname)
            : u.origin === location.origin;
        if (ok) location.href = u.href;
      }
    } catch {
      /* ignore malformed URLs */
    }
    return null;
  };
  // Dialog neutralisation is NOT installed here — it lives in the standalone,
  // eagerly-injected `neutralizeDialogsInPage` (FR-EX-073) so it can't be gated
  // by network-patch success or miss dialogs fired during page load.
}

// FR-EX-073 (MAIN world) — neutralise native JS dialogs on the current window so
// they can never block the crawl: alert→no-op, confirm→false, prompt→null, and
// suppress beforeunload. Idempotent. Self-contained (injected via executeScript,
// document_start / all-frames) — installed BEFORE the page's own scripts run.
export function neutralizeDialogsInPage(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (w.__scDialogsPatched) return;
  w.__scDialogsPatched = true;
  try {
    w.alert = () => undefined;
    w.confirm = () => false;
    w.prompt = () => null;

    // Swallow beforeunload so a handler registered BEFORE us (bubble/target phase
    // or via window.onbeforeunload) can't arm the "Leave site?" prompt: our
    // capture-phase listener runs first and stops the others from running.
    // CRITICAL: set returnValue = "" (empty), NEVER undefined — assigning
    // undefined coerces to the DOMString "undefined", which is NON-empty and so
    // itself arms the very prompt this is meant to suppress (EC-022).
    w.addEventListener(
      "beforeunload",
      (e: { stopImmediatePropagation?: () => void; returnValue?: unknown }) => {
        e.stopImmediatePropagation?.();
        e.returnValue = "";
      },
      true,
    );

    // Lock window.onbeforeunload to null so the page can't (re)assign a handler:
    // clear it via the real setter first, then shadow it with a no-op setter.
    w.onbeforeunload = null;
    try {
      Object.defineProperty(w, "onbeforeunload", {
        configurable: true,
        get: () => null,
        set: () => {},
      });
    } catch {
      /* engine forbids redefining it — the capture-phase swallow still covers us */
    }

    // Drop any FURTHER beforeunload registration at the source, so a handler
    // added after us (e.g. when a form goes dirty) can never arm the prompt.
    // Other event types pass straight through.
    const origAdd = w.addEventListener.bind(w);
    w.addEventListener = function (type: unknown, ...rest: unknown[]) {
      if (typeof type === "string" && type.toLowerCase() === "beforeunload") return undefined;
      return origAdd(type, ...rest);
    };
  } catch {
    /* ignore */
  }
}

/**
 * FR-EX-073 — neutralise native JS dialogs on a window-like object: alert→no-op,
 * confirm→false, prompt→null, and suppress beforeunload. Exported + unit-tested;
 * the canonical copy is inlined in `installNetworkCounter` (MAIN world) because
 * executeScript can't serialise a call to an imported helper.
 */
export function neutralizeDialogs(w: {
  alert?: unknown;
  confirm?: unknown;
  prompt?: unknown;
  onbeforeunload?: unknown;
  addEventListener?: (type: string, handler: (e: unknown) => void, capture?: boolean) => void;
}): void {
  w.alert = () => undefined;
  w.confirm = () => false;
  w.prompt = () => null;
  const origAdd = w.addEventListener;
  try {
    origAdd?.call(
      w,
      "beforeunload",
      (e) => {
        const ev = e as { stopImmediatePropagation?: () => void; returnValue?: unknown };
        ev.stopImmediatePropagation?.();
        // "" (empty), NEVER undefined — undefined coerces to "undefined", which arms the prompt.
        ev.returnValue = "";
      },
      true,
    );
  } catch {
    /* ignore */
  }
  // Lock onbeforeunload to null (clear via the real setter, then shadow it).
  w.onbeforeunload = null;
  try {
    Object.defineProperty(w, "onbeforeunload", {
      configurable: true,
      get: () => null,
      set: () => {},
    });
  } catch {
    /* ignore */
  }
  // Swallow any further beforeunload registration; other events pass through.
  if (typeof origAdd === "function") {
    w.addEventListener = function (type: string, ...rest: unknown[]) {
      if (typeof type === "string" && type.toLowerCase() === "beforeunload") return undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (origAdd as any).call(w, type, ...rest);
    } as typeof w.addEventListener;
  }
}

// FR-EX-032 (MAIN world) — resolve once the UI is stable: MutationObserver quiet
// for ≥ quietMs AND no in-flight fetch/XHR (window.__scInflight === 0), OR after
// timeoutMs. Any DOM mutation or network settle restarts the quiet window.
// executeScript awaits the returned promise. Mirrors lib/crawl.ts `stabilitySettled`.
export function waitForStable(opts: { quietMs: number; timeoutMs: number }): Promise<{
  settled: boolean;
}> {
  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    let done = false;
    let quiet: number | undefined;

    const inflight = (): number => (typeof w.__scInflight === "number" ? w.__scInflight : 0);
    const finish = (settled: boolean): void => {
      if (done) return;
      done = true;
      obs.disconnect();
      if (quiet) clearTimeout(quiet);
      clearTimeout(hard);
      if (w.__scOnNetChange === onChange) w.__scOnNetChange = undefined;
      resolve({ settled });
    };
    const tryFinish = (): void => {
      if (done) return;
      if (inflight() <= 0) finish(true);
      else arm(); // DOM quiet but network still busy → keep waiting
    };
    const arm = (): void => {
      if (quiet) clearTimeout(quiet);
      quiet = window.setTimeout(tryFinish, opts.quietMs);
    };
    const onChange = (): void => arm();

    const obs = new MutationObserver(onChange);
    const hard = window.setTimeout(() => finish(false), opts.timeoutMs);
    w.__scOnNetChange = onChange; // network settles restart the quiet window too
    obs.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    arm();
  });
}

/** Scroll to an absolute Y offset and report page metrics (scroll-and-capture). */
export function scrollToY(opts: { y: number }): {
  scrollY: number;
  scrollHeight: number;
  innerHeight: number;
} {
  window.scrollTo(0, opts.y);
  const doc = document.documentElement;
  const bodyH = document.body ? document.body.scrollHeight : 0;
  return {
    scrollY: window.scrollY,
    scrollHeight: Math.max(doc.scrollHeight, bodyH),
    innerHeight: window.innerHeight,
  };
}

/** Current location — used to detect origin escapes and report progress. */
export function getLocation(): { url: string; origin: string } {
  return { url: location.href, origin: location.origin };
}

// FR-EX-040/043 — build a structural signature of the current UI state: a
// compact skeleton of the *visible* DOM (tag[:role] plus aria state flags) with
// landmark texts (headings, dialog/tab labels), ignoring known-volatile nodes
// (ads, toasts, clocks, carousels). The popup hashes this into the fingerprint.
// Self-contained (serialized by executeScript). Sensitive to opened modals /
// expanded accordions / active tab-panels so sub-states hash differently.
export function extractStateSignature(): {
  url: string;
  origin: string;
  title: string;
  viewport: { width: number; height: number };
  signature: string;
} {
  const VOLATILE_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "LINK",
    "META",
    "SVG",
    "PATH",
  ]);
  const VOLATILE_HINT =
    /(toast|snackbar|notification|advert|\bads?\b|clock|ticker|carousel|cookie|skeleton|shimmer)/i;
  const MAX_NODES = 4000;

  let count = 0;
  const parts: string[] = [];

  function isVisible(el: Element): boolean {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function isVolatile(el: Element): boolean {
    if (VOLATILE_TAGS.has(el.tagName)) return true;
    const id = el.id || "";
    const cls = typeof el.className === "string" ? el.className : "";
    const role = el.getAttribute("role") || "";
    if (VOLATILE_HINT.test(`${id} ${cls} ${role}`)) return true;
    if (el.getAttribute("aria-live")) return true; // live regions = volatile
    return false;
  }

  function walk(node: Element, depth: number): void {
    if (count > MAX_NODES || depth > 40) return;
    if (isVolatile(node) || !isVisible(node)) return;
    count++;

    const tag = node.tagName.toLowerCase();
    const role = node.getAttribute("role") || "";
    let token = tag + (role ? ":" + role : "");
    const expanded = node.getAttribute("aria-expanded");
    if (expanded) token += "+e" + expanded;
    const selected = node.getAttribute("aria-selected");
    if (selected) token += "+s" + selected;
    const checked = node.getAttribute("aria-checked");
    if (checked) token += "+c" + checked;
    if (node.tagName === "DETAILS" && (node as HTMLDetailsElement).open) token += "+open";
    parts.push(token);

    // Landmark texts help distinguish otherwise-identical structures.
    if (/^h[1-6]$/.test(tag) || role === "heading" || role === "dialog" || role === "tab") {
      const t = (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (t) parts.push("¶" + t);
    }

    const kids = node.children;
    for (let i = 0; i < kids.length; i++) walk(kids[i]!, depth + 1);
  }

  if (document.body) walk(document.body, 0);

  // Open dialogs dominate the state — count them explicitly (FR-EX-043).
  const dialogs = document.querySelectorAll(
    '[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"]',
  ).length;

  const signature = `d${dialogs}|n${count}|` + parts.join(">");
  return {
    url: location.href,
    origin: location.origin,
    title: document.title || "",
    viewport: { width: window.innerWidth, height: window.innerHeight },
    signature,
  };
}

// FR-EX-053 — cover every element matching `selectors` with an opaque overlay so
// PII never reaches the screenshot. Applied immediately BEFORE each capture and
// removed after. Overlays use fixed/viewport coords (captureVisibleTab is
// viewport-only) and a solid fill. Self-contained; bad selectors are skipped.
export function applyMasks(opts: { selectors: string[] }): { masked: number } {
  document.querySelectorAll("[data-sc-mask]").forEach((n) => n.remove());
  const selectors = (opts.selectors || []).filter((s) => typeof s === "string" && s.trim() !== "");
  if (selectors.length === 0) return { masked: 0 };

  const seen = new Set<Element>();
  let masked = 0;
  for (const sel of selectors) {
    let nodes: NodeListOf<Element>;
    try {
      nodes = document.querySelectorAll(sel);
    } catch {
      continue; // invalid selector — skip, never throw mid-capture
    }
    nodes.forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const box = document.createElement("div");
      box.setAttribute("data-sc-mask", "");
      Object.assign(box.style, {
        position: "fixed",
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
        background: "#000",
        opacity: "1",
        pointerEvents: "none",
        zIndex: "2147483647",
      });
      document.documentElement.appendChild(box);
      masked++;
    });
  }
  return { masked };
}

/** Remove all mask overlays applied by applyMasks (FR-EX-053). */
export function removeMasks(): void {
  document.querySelectorAll("[data-sc-mask]").forEach((n) => n.remove());
}

// FR-EX-011 — inject the "SnapCrawl running – do not interact" badge into the
// crawl tab (SRS §7.1). Idempotent, pointer-events:none so it never intercepts
// the crawl's own clicks. Hidden during captures so it never appears in
// screenshots (see setRunBadgeVisible).
export function applyRunBadge(): void {
  if (document.querySelector("[data-sc-badge]")) return;
  const b = document.createElement("div");
  b.setAttribute("data-sc-badge", "");
  b.textContent = "● SnapCrawl running — do not interact with this window";
  Object.assign(b.style, {
    position: "fixed",
    top: "0",
    left: "0",
    right: "0",
    height: "24px",
    lineHeight: "24px",
    zIndex: "2147483647",
    background: "#0B6BCB",
    color: "#fff",
    fontFamily: "system-ui, sans-serif",
    fontSize: "12px",
    fontWeight: "600",
    textAlign: "center",
    pointerEvents: "none",
  });
  (document.documentElement || document.body).appendChild(b);
}

export function removeRunBadge(): void {
  document.querySelectorAll("[data-sc-badge]").forEach((n) => n.remove());
}

/** Toggle the badge's visibility (hidden while a capture is taken). */
export function setRunBadgeVisible(opts: { visible: boolean }): void {
  document.querySelectorAll("[data-sc-badge]").forEach((n) => {
    (n as HTMLElement).style.display = opts.visible ? "block" : "none";
  });
}

/** Remove all data-sc-idx marks left by discoverCandidates. */
export function cleanupMarks(): void {
  document.querySelectorAll("[data-sc-idx]").forEach((n) => n.removeAttribute("data-sc-idx"));
}
