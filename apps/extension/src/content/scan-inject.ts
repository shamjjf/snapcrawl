// DEV DEMO ONLY — a self-contained page scanner for the popup's "Scan this page"
// button. It MUST be self-contained (no imports, all helpers nested) because it
// is serialized and injected into the page via chrome.scripting.executeScript({ func }).
// The canonical, unit-tested logic lives in discovery.ts / visibility.ts / safety.ts.
//
// Blue outline = a clickable target. Red outline = destructive & blocked (only
// when `safety` is on). Returns how many were counted as each.
export function scanAndHighlight(opts: { safety: boolean; blocklist: string[] }): {
  clickable: number;
  blocked: number;
} {
  const CANDIDATE =
    "a[href],button,input[type=submit],input[type=button],input[type=image]," +
    "[role=button],[role=link],[role=tab],[role=menuitem],[onclick]";

  document.querySelectorAll("[data-snapcrawl-hl]").forEach((n) => n.remove());

  // strong = real interactive elements; weak = cursor:pointer-only (often just
  // inherited from a clickable ancestor, e.g. a button's text).
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

  // Safety check (FR-EX-070) — mirrors safety.ts, inlined for self-containment.
  const needles = opts.blocklist
    .map((s) => s.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);
  function isDestructive(el: Element): boolean {
    if (!opts.safety || needles.length === 0) return false;
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

  const overlay = document.createElement("div");
  overlay.setAttribute("data-snapcrawl-hl", "");
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
    zIndex: "2147483000",
  });

  let clickable = 0;
  let blocked = 0;
  for (const el of targets) {
    if (!interactable(el)) continue;
    const danger = isDestructive(el);
    const r = el.getBoundingClientRect();
    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed",
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      border: `2px solid ${danger ? "#dc2626" : "#0b6bcb"}`,
      background: danger ? "rgba(220,38,38,0.14)" : "rgba(11,107,203,0.12)",
      borderRadius: "3px",
      boxSizing: "border-box",
    });
    overlay.appendChild(box);
    if (danger) blocked++;
    else clickable++;
  }

  document.documentElement.appendChild(overlay);
  window.setTimeout(() => overlay.remove(), 4000);
  return { clickable, blocked };
}
