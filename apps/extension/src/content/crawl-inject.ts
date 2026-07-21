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
  /** Matches the project's excludeSelectors, or (links only) excludeUrlPatterns
   *  (FR-EX-026). Flagged rather than dropped so the engine can log the skip —
   *  injected code has no chrome.* access and cannot log for itself. */
  excluded: boolean;
  /** Clicking this would submit a form (FR-EX-034). */
  submit: boolean;
  /** FR-EX-075 / EC-006 — clicking this pops a native OS dialog the crawler can
   *  neither fill nor dismiss (a file picker above all), which stalls the whole
   *  loop until a human acts. input[type=file], a <label> bound to one, or
   *  another native-picker input. Flagged not dropped so the engine records
   *  skipped-file rather than the omission being silent. */
  nativeDialog: boolean;
  /** One of siblingCollapseLimit-plus repeated look-alikes (FR-EX-025): the
   *  3rd+ "Delete" in a table, the 3rd+ product card. Flagged not dropped so the
   *  engine can record it skipped-similar. */
  similar: boolean;
  /** FR-EX-024 — the element fingerprint: `selector` + a hash of tag/role/text.
   *  What the visited set, pairKey and edges reference. */
  key: string;
  /** FR-EX-024 — robust CSS path: a unique id/data-testid/aria-label anchor where
   *  the element (or its nearest useful ancestor) has one, else structural.
   *  Reused as the trigger descriptor's selector (FR-EX-054). */
  selector: string;
  /** The element's OWN unique anchor, or null when it has none. Kept apart from
   *  `selector` so matchCandidate can tell a strong identity ("this exact
   *  data-testid") from a positional guess that merely looks like one. */
  anchor: string | null;
  /** FR-EX-061 — a stable identifier for the RECORD this control belongs to (the
   *  table row / list card): a link href, a data-id, or a hash of the record's
   *  text. Lets replay re-anchor "the Deactivate button in alice's row" to the
   *  right row after the table re-renders and reorders — position and the button's
   *  own descriptor are identical across rows, so only the record identity tells
   *  them apart. null when the control isn't inside a repeated record. */
  containerKey: string | null;
}

export interface DiscoverResult {
  url: string;
  origin: string;
  candidates: InjectedCandidate[];
  /** FR-EX-023 / C-04 — cross-origin iframes discovery could not see into. The
   *  engine records these as unreachable regions; content scripts can't reach
   *  across the origin boundary, so their contents are simply invisible. */
  unreachableFrames: number;
}

// FR-EX-020/021/022/070 — find clickable, interactable targets and tag each with
// a data-sc-idx attribute so clickCandidate can re-select the exact element.
export function discoverCandidates(opts: {
  blocklist: string[];
  /** FR-EX-026 — never-click CSS selectors and (link-only) URL regexes. */
  excludeSelectors?: string[];
  excludeUrlPatterns?: string[];
  /** FR-EX-025 — keep at most this many of each repeated look-alike (default 2). */
  siblingCollapseLimit?: number;
  /** FR-EX-023 — how many same-origin iframe boundaries to recurse through
   *  (default 5). A frame nested deeper is left uncrawled and counted. */
  maxFrameDepth?: number;
}): DiscoverResult {
  const CANDIDATE =
    "a[href],button,input[type=submit],input[type=button],input[type=image]," +
    "[role=button],[role=link],[role=tab],[role=menuitem],[onclick]";

  // Style must be read from the element's OWN view: getComputedStyle bound to the
  // top window throws (or lies) for an element living in a sub-document (an
  // iframe). Every style read below goes through this.
  function styleOf(el: Element): CSSStyleDeclaration | null {
    try {
      const view = el.ownerDocument?.defaultView || window;
      return view.getComputedStyle(el);
    } catch {
      return null;
    }
  }

  // FR-EX-022 — recurse into open shadow roots. querySelectorAll does not pierce
  // a shadow boundary, so a single document-level scan is blind to every control
  // inside every web component. CLOSED roots stay invisible: shadowRoot is null
  // for them by design and there is no supported way in.
  // FR-EX-023 / C-04 — also recurse into SAME-ORIGIN iframes. A cross-origin
  // iframe's contentDocument is unreachable (throws or is null by the same-origin
  // policy the browser enforces on us too); count it and move on.
  const maxFrameDepth =
    typeof opts.maxFrameDepth === "number" && opts.maxFrameDepth >= 0 ? opts.maxFrameDepth : 5;
  const roots: (Document | ShadowRoot)[] = [];
  const strong = new Set<Element>();
  const weak = new Set<Element>();
  let unreachableFrames = 0;
  // `frameDepth` counts IFRAME boundaries crossed, not shadow ones: shadow nesting
  // is cheap and naturally bounded, whereas nested frames are heavy and can be
  // adversarially deep. A frame past the limit is left uncrawled and counted as a
  // region we didn't reach — same bucket as a cross-origin frame (FR-EX-023).
  function collect(root: Document | ShadowRoot, frameDepth: number): void {
    if (roots.length > 200) return; // pathological total fan-out — hard backstop
    roots.push(root);
    root.querySelectorAll(CANDIDATE).forEach((el) => strong.add(el));
    root.querySelectorAll("*").forEach((el) => {
      if (!strong.has(el) && cursorIsPointer(el)) weak.add(el);
      const sr = (el as HTMLElement).shadowRoot;
      if (sr) collect(sr, frameDepth); // shadow keeps the same frame depth
      if (el.tagName === "IFRAME") {
        if (frameDepth >= maxFrameDepth) {
          unreachableFrames++; // too deeply nested to descend (FR-EX-023 depth limit)
          return;
        }
        let doc: Document | null = null;
        try {
          doc = (el as HTMLIFrameElement).contentDocument;
        } catch {
          doc = null; // cross-origin — the access itself throws
        }
        if (doc && doc.documentElement) collect(doc, frameDepth + 1);
        else unreachableFrames++; // cross-origin / not-yet-loaded (C-04)
      }
    });
  }
  function cursorIsPointer(el: Element): boolean {
    return styleOf(el)?.cursor === "pointer";
  }
  collect(document, 0);

  // Old marks may be anywhere, including inside a shadow root — clear across
  // every root we found, or a stale data-sc-idx survives and clickCandidate can
  // resolve an index to last cycle's element.
  for (const r of roots) r.querySelectorAll("[data-sc-idx]").forEach((n) => n.removeAttribute("data-sc-idx"));

  const all = new Set<Element>([...strong, ...weak]);

  /** Parent, crossing a shadow boundary via the host (FR-EX-022) and an iframe
   *  boundary via frameElement (FR-EX-023). At the top document, neither exists. */
  function upFrom(el: Element): Element | null {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode() as { host?: Element } | null;
    if (root && root.host) return root.host;
    const fe = el.ownerDocument?.defaultView?.frameElement;
    return (fe as Element) || null;
  }

  function hasClickableAncestor(el: Element): boolean {
    let p = upFrom(el);
    while (p) {
      if (all.has(p)) return true;
      p = upFrom(p);
    }
    return false;
  }
  const targets: Element[] = [];
  strong.forEach((el) => targets.push(el));
  weak.forEach((el) => {
    if (!hasClickableAncestor(el)) targets.push(el);
  });

  /** Deepest element at (x, y), descending through shadow roots. document's own
   *  elementFromPoint stops at the HOST — it never reports a node inside a
   *  component — so without this every shadow candidate looks "covered". */
  function deepElementFromPoint(x: number, y: number): Element | null {
    let node = document.elementFromPoint(x, y);
    let guard = 0;
    while (node && (node as HTMLElement).shadowRoot && guard++ < 20) {
      const inner = (node as HTMLElement).shadowRoot!.elementFromPoint(x, y);
      if (!inner || inner === node) break;
      node = inner;
    }
    return node;
  }

  /** Does `a` contain `b`, crossing shadow boundaries? Node.contains() does not
   *  pierce, so it answers false for a host vs its own shadow content. */
  function containsDeep(a: Element, b: Element): boolean {
    let n: Element | null = b;
    let guard = 0;
    while (n && guard++ < 200) {
      if (n === a) return true;
      n = upFrom(n);
    }
    return false;
  }

  // FR-EX-021 — visible AND interactable: attached, enabled, rendered, sized,
  // and hit-testable at its centre. Mirrors visibility.ts isInteractable.
  function interactable(el: Element): boolean {
    if (!el.isConnected) return false;
    if ((el as HTMLButtonElement).disabled) return false;
    if (el.getAttribute("aria-disabled") === "true") return false;
    const s = styleOf(el);
    if (s) {
      if (s.display === "none") return false;
      if (s.visibility === "hidden" || s.visibility === "collapse") return false;
    }
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;

    // FR-EX-023 — an element inside an iframe has a rect in the IFRAME's viewport,
    // not the top window's, so a top-document elementFromPoint hit-test at those
    // coordinates is meaningless (it would test the wrong point and reject nearly
    // everything). Cross-frame hit-testing isn't reliably available to us, so for
    // sub-document elements we accept on visibility + size alone.
    if (el.ownerDocument !== document) return true;

    // Hit-test (FR-EX-021): is this actually the thing a click at its centre
    // would land on, or is it underneath a modal backdrop / cookie wall / an
    // overlapping sticky header? A covered element is not clickable by a user,
    // and clicking it anyway dispatches at coordinates the app will hand to
    // whatever is really on top.
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // Off-screen at the CURRENT scroll position is not "covered" — we discover
    // without scrolling, so most of a long page is out of view and hit-testing
    // it here would discard the whole page below the fold. clickCandidate
    // scrolls it into view before dispatching.
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return true;
    const top = deepElementFromPoint(cx, cy);
    if (!top) return false;
    return el === top || containsDeep(el, top) || containsDeep(top, el);
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

  // FR-EX-026 — never click these. Compiled ONCE here, not per element (mirrors
  // the `needles` precompute above). Both loops drop anything that won't compile:
  // a throw from this function is caught by the engine as "discover-failed",
  // which can end the run — so one fat-fingered selector must not kill a crawl.
  // The API validates excludeUrlPatterns as regexes at write time but doesn't
  // validate excludeSelectors as CSS at all, and unpaired configs never see the
  // API, so this guard is load-bearing.
  const excludeSelectors = (opts.excludeSelectors || []).filter(
    (s) => typeof s === "string" && s.trim() !== "",
  );
  const excludeUrlRes: RegExp[] = [];
  for (const p of opts.excludeUrlPatterns || []) {
    if (typeof p !== "string" || p.trim() === "") continue;
    try {
      excludeUrlRes.push(new RegExp(p)); // regex, not glob — matches the API's own validation
    } catch {
      continue; // invalid pattern — skip, never throw mid-discovery
    }
  }
  function isExcluded(el: Element, href: string | null): boolean {
    for (const sel of excludeSelectors) {
      try {
        // closest, not matches: a child of an excluded container is excluded too.
        if (el.closest(sel)) return true;
      } catch {
        continue; // invalid selector — skip, never throw mid-discovery
      }
    }
    // URL patterns apply to LINKS only (FR-EX-026), so a button whose text
    // happens to match a pattern is not excluded.
    if (href) {
      for (const re of excludeUrlRes) {
        if (re.test(href)) return true;
      }
    }
    return false;
  }

  // FR-EX-034 — would clicking this submit a form? Mirrors safety.ts isFormSubmit.
  // A bare <button> in a form defaults to type=submit (BUTTON only — a typeless
  // <input> defaults to text); `.form` also resolves the form="id" association
  // that closest("form") would miss.
  function isFormSubmit(el: Element): boolean {
    const tag = el.tagName;
    if (tag !== "BUTTON" && tag !== "INPUT") return false;
    const owner = el as HTMLButtonElement | HTMLInputElement;
    if (!owner.form) return false;
    // Resolved .type, not getAttribute("type") — HTML's invalid-value-default
    // makes <button type="sumbit"> resolve to "submit", which is how the browser
    // will treat the click. Reading the raw attribute lets any typo, casing or
    // stray space walk straight through the gate and submit the form.
    const type = owner.type.toLowerCase();
    if (tag === "BUTTON") return type === "submit";
    return type === "submit" || type === "image";
  }

  // FR-EX-075 / EC-006 — would clicking this open a native OS dialog the crawler
  // can neither fill nor dismiss? A file picker blocks the whole loop until a
  // human acts on it. Covers input[type=file] and the other native-picker input
  // types, plus a <label> bound to such an input (clicking the label opens the
  // input's dialog — the common "styled upload button" pattern). A plain
  // <button> that calls input.click() from a JS handler is not DOM-detectable
  // and is out of scope; the SRS names input[type=file] specifically.
  const NATIVE_INPUT_TYPES = new Set([
    "file",
    "color",
    "date",
    "datetime-local",
    "month",
    "week",
    "time",
  ]);
  function opensNativeDialog(el: Element): boolean {
    if (el.tagName === "INPUT" && NATIVE_INPUT_TYPES.has((el as HTMLInputElement).type)) return true;
    if (el.tagName === "LABEL") {
      const c = (el as HTMLLabelElement).control;
      if (c && c.tagName === "INPUT" && NATIVE_INPUT_TYPES.has((c as HTMLInputElement).type))
        return true;
    }
    return false;
  }

  // ── FR-EX-024 — stable element fingerprint ────────────────────────────────
  // "A robust CSS path (preferring id/data-testid/aria-label) plus a hash of tag,
  // role, and normalised text." This is what the visited set, pairKey and edges
  // reference, and what matchCandidate re-finds a recorded element by after the
  // app re-renders. Mirrors discovery.ts buildSelector.

  // Frameworks mint an id per render: React useId → ":r3:", Radix →
  // "radix-:r1:", Emotion/MUI → "css-1q2w3e", Angular → "ng-4021". PREFERRING
  // one of those makes the fingerprint less stable, not more — the element gets
  // a fresh identity on every render, so the visited set never hits and replay
  // can never re-find it. That is worse than the structural path we'd otherwise
  // have used, so reject them and fall through.
  function volatileToken(v: string): boolean {
    if (v.length > 64) return true;
    if (/:r[0-9a-z]+:/i.test(v)) return true; // React useId, Radix, Ariakit
    if (/^(css|jss|sc|mui|emotion|ember|ext-gen|yui)[-_]?\d/i.test(v)) return true;
    if (/^ng-/i.test(v)) return true;
    // A long hex run WITH a digit in it — uuids, content hashes, object ids.
    // The digit requirement keeps real words ("addbutton", "facade") out of it.
    const hex = v.match(/[0-9a-f]{8,}/i);
    return hex !== null && /\d/.test(hex[0]);
  }

  function cssEsc(s: string): string {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
    return s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }
  function attrEsc(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  const TESTID_ATTRS = ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"];

  // A CSS path must identify ONE element. A repeated data-testid (the norm —
  // `data-testid="row-delete"` on every row) would otherwise collapse every row
  // to a single fingerprint, and the crawler would expand exactly one of them.
  // So an anchor only counts when it is unique within its own root. Scoped to
  // getRootNode(), not document, because querySelectorAll doesn't pierce shadow
  // roots (FR-EX-022).
  function isUnique(el: Element, sel: string): boolean {
    try {
      const root = el.getRootNode() as ParentNode & { querySelectorAll?: unknown };
      if (typeof root.querySelectorAll !== "function") return false;
      return (root as ParentNode).querySelectorAll(sel).length === 1;
    } catch {
      return false; // unparseable selector — treat as no anchor
    }
  }

  const anchorCache = new Map<Element, string | null>();
  function stableAnchor(el: Element): string | null {
    const hit = anchorCache.get(el);
    if (hit !== undefined) return hit;
    const tag = el.tagName.toLowerCase();
    let found: string | null = null;
    const tryIt = (sel: string, raw: string): boolean => {
      if (!raw || volatileToken(raw) || !isUnique(el, sel)) return false;
      found = sel;
      return true;
    };
    for (const a of TESTID_ATTRS) {
      const v = el.getAttribute(a);
      if (v && tryIt(`[${a}="${attrEsc(v)}"]`, v)) break;
    }
    if (!found && el.id) tryIt(`#${cssEsc(el.id)}`, el.id);
    if (!found) {
      const aria = el.getAttribute("aria-label");
      if (aria) tryIt(`${tag}[aria-label="${attrEsc(aria)}"]`, aria);
    }
    if (!found) {
      const name = el.getAttribute("name");
      if (name) tryIt(`${tag}[name="${attrEsc(name)}"]`, name);
    }
    anchorCache.set(el, found);
    return found;
  }

  // Cross a shadow boundary on the way up (FR-EX-022): a shadow root has no
  // parentElement, so a plain walk stops dead at the boundary and every element
  // inside every instance of a component produces the SAME path.
  function pathParent(el: Element): { el: Element; shadow: boolean } | null {
    if (el.parentElement) return { el: el.parentElement, shadow: false };
    const root = el.getRootNode() as { host?: Element } | null;
    if (root && root.host) return { el: root.host, shadow: true };
    return null;
  }

  // FR-EX-023 — an element in a same-origin iframe otherwise gets a path relative
  // to its OWN document, so two identical iframes yield identical paths and
  // collapse to one fingerprint. Prefix every in-frame path with the iframe's own
  // path in the parent document (recursively, for nested frames). "" at the top.
  function framePrefix(el: Element): string {
    const fe = el.ownerDocument?.defaultView?.frameElement;
    if (!fe) return "";
    return robustPath(fe as Element) + ">::frame>";
  }

  // Robust path: the element's own unique anchor if it has one; otherwise
  // tag+nth-of-tag upwards, stopping early at the nearest ANCHORED ancestor
  // (so the path is immune to churn above that point) — structurally-identical
  // siblings (table rows, cards) still get DISTINCT paths, and therefore
  // distinct fingerprints, and are each expanded.
  function robustPath(el: Element): string {
    const prefix = framePrefix(el); // "" unless el lives in an iframe (FR-EX-023)
    const own = stableAnchor(el);
    if (own) return prefix + own;
    const parts: string[] = [];
    let node: Element | null = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 8) {
      let nth = 1;
      let sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === node.tagName) nth++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(`${node.tagName.toLowerCase()}:${nth}`);
      const up = pathParent(node);
      if (!up) break;
      if (up.shadow) parts.unshift("::shadow"); // light-DOM vs shadow child never collide
      const anchored = stableAnchor(up.el);
      if (anchored) {
        parts.unshift(anchored);
        break;
      }
      node = up.el;
      depth++;
    }
    return prefix + parts.join(">");
  }

  // FR-EX-061 — the stable key of the RECORD an element belongs to. Walk up to
  // the nearest record container (a row/card/list-item), then identify that
  // record by something that survives a re-render and a reorder:
  //   1. a link href inside it — the record's own URL, the strongest signal;
  //   2. a stable data-id/id on the container itself;
  //   3. a hash of the record's visible text (the row's name/email etc.).
  // Position and the button's descriptor are identical across sibling records, so
  // this is the ONLY thing that re-anchors the recorded control to the right row.
  const RECORD_ROLES = new Set(["row", "listitem", "article", "option", "gridcell", "treeitem"]);
  const RECORD_TAGS = new Set(["TR", "LI"]);
  function containerKey(el: Element): string | null {
    let node: Element | null = upFrom(el);
    let hops = 0;
    while (node && hops < 8) {
      const isRecord = RECORD_TAGS.has(node.tagName) || RECORD_ROLES.has(node.getAttribute("role") || "");
      if (isRecord) {
        let link: Element | null = null;
        try {
          link = node.querySelector("a[href]");
        } catch {
          link = null;
        }
        const href = link && (link as HTMLAnchorElement).href;
        if (href) return "h:" + href; // hrefs are content identity — never volatile-filtered
        const own = stableAnchor(node);
        if (own) return "a:" + own;
        const t = (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
        if (t) return "t:" + hash32(t);
        return null; // a record with no distinguishing content — no usable key
      }
      node = upFrom(node);
      hops++;
    }
    return null;
  }

  // FNV-1a/32. Not a security hash — a compact, synchronous identity digest.
  // (crypto.subtle is async and would make discovery a promise for no gain.)
  function hash32(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  // FR-EX-025 — collapse repeated look-alikes. Two candidates belong to the same
  // group when their SHAPE matches with positional and numeric noise removed:
  // digits stripped from the structural path (so `#row-41-del` and `#row-42-del`,
  // or `tr:5>button` and `tr:6>button`, coincide) and from the visible text and
  // href (so "Delete #41"/"Delete #42", "?page=1"/"?page=2" coincide). Distinct
  // controls stay distinct: Home/Alpha/Beta share a path shape but not text, so
  // they never merge. The count is kept per group and only the first `limit`
  // survive; caller default is 2.
  const collapseLimit =
    typeof opts.siblingCollapseLimit === "number" && opts.siblingCollapseLimit >= 0
      ? opts.siblingCollapseLimit
      : 2;
  const stripDigits = (s: string): string => s.replace(/\d+/g, "#");
  const groupCounts = new Map<string, number>();

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
    const excluded = isExcluded(el, href); // FR-EX-026
    const submit = isFormSubmit(el); // FR-EX-034
    const nativeDialog = opensNativeDialog(el); // FR-EX-075
    const anchor = stableAnchor(el);
    const selector = robustPath(el);
    const container = containerKey(el); // FR-EX-061 — record identity for replay re-anchor
    // FR-EX-024 — robust CSS path + a hash of tag, role and normalised text.
    // `key` deliberately excludes the flags: it feeds the visited set and
    // pairKey, so folding config-derived state into it would invalidate every
    // visited entry and every in-flight checkpoint the moment a config changed.
    const key = `${selector}#${hash32(`${tag}|${role || ""}|${text}`)}`;

    // FR-EX-025 — is this the (limit+1)th-or-later of its look-alike group?
    // max(1, limit) guarantees we NEVER flag a lone element (a group of one is
    // not "repeated") and always keep at least one representative.
    const groupKey = `${tag}|${role || ""}|${stripDigits(selector)}|${stripDigits(text)}|${stripDigits(href || "")}`;
    const seen = groupCounts.get(groupKey) ?? 0;
    groupCounts.set(groupKey, seen + 1);
    const similar = seen >= Math.max(1, collapseLimit);

    candidates.push({
      idx,
      tag,
      role,
      text,
      href,
      destructive,
      excluded,
      submit,
      nativeDialog,
      similar,
      key,
      selector,
      anchor,
      containerKey: container,
    });
    idx++;
  }
  return { url: location.href, origin: location.origin, candidates, unreachableFrames };
}

// FR-EX-031 — safeClick: scroll into view, dispatch hover then a trusted-like
// pointerdown/pointerup/click sequence at the element centre. Refuses links that
// leave the project's allowedDomains (FR-EX-010/071) and neutralises new-tab
// targets (FR-EX-072). Self-contained; `allowedDomains` [] ⇒ no restriction.
//
// FR-EX-035 — when `fillForm` is set (the engine passes it only for a submit
// element whose project enabled form-fill), the owning form's empty text-like
// fields are filled with dummy presets BEFORE the click, so the submit reaches a
// real post-submit state instead of a validation wall. `filled` reports the
// count so the engine can log the decision. Dummy values only — never a real
// secret (C-05). Fields inside a maskSelectors region are left untouched.
export function clickCandidate(opts: {
  idx: number;
  allowedDomains: string[];
  fillForm?: boolean;
  maskSelectors?: string[];
}): {
  ok: boolean;
  reason?: string;
  filled?: number;
} {
  // Shadow- AND iframe-piercing lookup (FR-EX-022/023). document.querySelector
  // stops at both a shadow boundary and an iframe boundary, so a plain lookup can
  // NEVER resolve a mark discovery placed inside a web component or a same-origin
  // frame — it would report "gone" for an element that is right there, and the
  // branch would be abandoned.
  const findMarked = (idx: number): HTMLElement | null => {
    const sel = `[data-sc-idx="${idx}"]`;
    const stack: (Document | ShadowRoot)[] = [document];
    let guard = 0;
    while (stack.length && guard++ < 5000) {
      const root = stack.pop()!;
      const hit = root.querySelector(sel);
      if (hit) return hit as HTMLElement;
      root.querySelectorAll("*").forEach((e) => {
        const sr = (e as HTMLElement).shadowRoot;
        if (sr) stack.push(sr);
        if (e.tagName === "IFRAME") {
          try {
            const d = (e as HTMLIFrameElement).contentDocument;
            if (d) stack.push(d);
          } catch {
            /* cross-origin — unreachable, skip */
          }
        }
      });
    }
    return null;
  };
  const el = findMarked(opts.idx);
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

  // FR-EX-035 — fill the owning form's empty fields before submitting it. The
  // engine only sets fillForm for a submit element (which it only clicks when the
  // project enabled clickSubmitEmptyForms), so this is a no-op on ordinary clicks.
  let filled = 0;
  if (opts.fillForm) {
    const form = (el as HTMLButtonElement | HTMLInputElement).form;
    if (form) filled = fillFormFields(form, opts.maskSelectors || []);
  }

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
  return { ok: true, filled };

  // FR-EX-035 — fill a form's empty text-like fields with dummy presets. Nested
  // (hoisted) so clickCandidate stays self-contained for executeScript. Only
  // EMPTY, enabled, non-masked text-like fields are touched; the value is set via
  // the native setter + input/change events so React/Vue controlled inputs
  // register it. Never a real secret (C-05) — every preset is obviously dummy.
  function fillFormFields(form: HTMLFormElement, maskSelectors: string[]): number {
    // Elements inside a masked (PII) region must not be filled (FR-EX-053 spirit).
    const masked: Element[] = [];
    for (const sel of maskSelectors) {
      if (typeof sel !== "string" || sel.trim() === "") continue;
      try {
        form.querySelectorAll(sel).forEach((n) => masked.push(n));
      } catch {
        /* invalid selector — skip, never throw mid-fill */
      }
    }
    const isMasked = (node: Element): boolean => masked.some((m) => m === node || m.contains(node));

    const setValue = (node: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
      try {
        const proto =
          node.tagName === "TEXTAREA"
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(node, value);
        else node.value = value;
      } catch {
        try {
          node.value = value;
        } catch {
          return;
        }
      }
      // React/Vue track the value on the node; a native set + input event is the
      // only way to make a controlled input actually register the new value.
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    };

    const presetFor = (node: HTMLInputElement | HTMLTextAreaElement, type: string): string => {
      const hint = [
        node.getAttribute("name"),
        node.getAttribute("autocomplete"),
        node.getAttribute("placeholder"),
        node.getAttribute("aria-label"),
        node.id,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      // Type wins over name hints where the input declares one.
      if (type === "email" || /\bemail\b|e-mail/.test(hint)) return "test@example.com";
      if (type === "password" || /password|passwd/.test(hint)) return "Test1234!"; // dummy, not a secret
      if (type === "tel" || /phone|tel|mobile/.test(hint)) return "5551234567";
      if (type === "url" || /\burl\b|website/.test(hint)) return "https://example.com";
      if (type === "number") return "1";
      if (/name/.test(hint)) return "Test User";
      return "test"; // search / text / textarea and anything else text-like
    };

    // Types that either aren't text-like or must never be auto-set.
    const SKIP_TYPES = new Set([
      "hidden",
      "submit",
      "button",
      "image",
      "reset",
      "checkbox",
      "radio",
      "file",
      "range",
      "color",
      "date",
      "datetime-local",
      "month",
      "week",
      "time",
    ]);

    let count = 0;
    const fields = form.querySelectorAll("input, textarea");
    for (const raw of Array.from(fields)) {
      const node = raw as HTMLInputElement | HTMLTextAreaElement;
      if (node.disabled || (node as HTMLInputElement).readOnly) continue;
      const type = (node.tagName === "TEXTAREA" ? "textarea" : (node as HTMLInputElement).type || "text").toLowerCase();
      if (SKIP_TYPES.has(type)) continue;
      if (node.value && node.value.trim() !== "") continue; // only EMPTY fields
      if (isMasked(node)) continue;
      setValue(node, presetFor(node, type));
      count++;
    }
    return count;
  }
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

  // FR-EX-042 — SPA route detection. history.pushState/replaceState and
  // popstate/hashchange change the route with no network request and no
  // GUARANTEED synchronous DOM mutation, so on a client-side navigation
  // waitForStable's quiet window could resolve against the OLD page before the
  // new route renders, and the fingerprint would be taken against a stale/skeleton
  // DOM. Signalling __scOnNetChange on each route change re-arms that window
  // exactly as a fetch settle does, so the post-click wait holds until the route
  // swap lands. __scOnNetChange is only set DURING a settle (waitForStable installs
  // it, clears it on finish), so this fires only for route changes a click caused —
  // between clicks there is nothing to re-arm. The re-fingerprint after every click
  // already reads location.href live, so URL attribution was never the gap; settle
  // timing was. Guarded by __scNetPatched at the top, so hooks install once per
  // context and re-install after a full navigation wipes the MAIN world.
  const routeChanged = (): void => {
    if (typeof w.__scOnNetChange === "function") {
      try {
        w.__scOnNetChange();
      } catch {
        /* ignore listener errors */
      }
    }
  };
  const hist = w.history;
  if (hist && typeof hist.pushState === "function") {
    const wrapHistory =
      (orig: (...a: unknown[]) => unknown) =>
      function (this: unknown, ...args: unknown[]) {
        const r = orig.apply(this, args); // apply the real navigation first
        routeChanged(); // then re-arm the settle so the render is awaited
        return r;
      };
    hist.pushState = wrapHistory(hist.pushState);
    hist.replaceState = wrapHistory(hist.replaceState);
  }
  w.addEventListener("popstate", routeChanged);
  w.addEventListener("hashchange", routeChanged);

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
  innerWidth: number;
  dpr: number;
} {
  window.scrollTo(0, opts.y);
  const doc = document.documentElement;
  const bodyH = document.body ? document.body.scrollHeight : 0;
  return {
    scrollY: window.scrollY, // may be clamped to the real max scroll — the caller relies on this
    scrollHeight: Math.max(doc.scrollHeight, bodyH),
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    dpr: window.devicePixelRatio || 1,
  };
}

/**
 * FR-EX-090 — wait for a viewport change to take effect, and report what the page
 * actually did about it. Injected, so self-contained.
 *
 * Polls until innerWidth reaches `expectWidth` (± tolerance for a scrollbar) or
 * the timeout expires, then gives layout one more frame to settle. Returns the
 * measured geometry plus a coarse structural signature, so the caller can tell a
 * genuine responsive re-render from a desktop layout merely squeezed narrower.
 *
 * This is NOT freezeForCapture: that one is idempotence-guarded and its image
 * wait only latches on images already incomplete, so immediately after an
 * emulation override it returns synchronously having waited for nothing.
 */
export function settleAfterViewportChange(opts: {
  expectWidth: number;
  timeoutMs: number;
}): Promise<{
  innerWidth: number;
  innerHeight: number;
  scrollY: number;
  dpr: number;
  hasMetaViewport: boolean;
  signature: string;
}> {
  const measure = () => {
    // Coarse shape of the layout: how many elements sit in each horizontal band.
    // A real responsive re-render collapses columns and changes this; a squeezed
    // desktop layout keeps roughly the same distribution.
    let cols = 0;
    let rows = 0;
    const body = document.body;
    if (body) {
      const kids = Array.from(body.querySelectorAll("*")).slice(0, 400);
      let lastTop = -1;
      for (const el of kids) {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        if (Math.abs(r.top - lastTop) < 4) cols++;
        else {
          rows++;
          lastTop = r.top;
        }
      }
    }
    return `r${rows}|c${cols}`;
  };

  const read = () => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollY: window.scrollY,
    dpr: window.devicePixelRatio || 1,
    hasMetaViewport: !!document.querySelector('meta[name="viewport"]'),
    signature: measure(),
  });

  if (opts.timeoutMs <= 0) return Promise.resolve(read());

  // MUST yield. A busy-wait here blocks the renderer's main thread, which means
  // layout can never run — innerWidth would never reach the emulated width, the
  // loop would always burn its full budget, and (because the renderer is frozen
  // while chrome.debugger is attached) Page.captureScreenshot would hang with it.
  // chrome.scripting.executeScript awaits a returned promise, so async is free.
  const deadline = Date.now() + opts.timeoutMs;
  const frame = (): Promise<void> =>
    new Promise((r) => {
      requestAnimationFrame(() => r());
    });

  return (async () => {
    while (Date.now() < deadline) {
      if (Math.abs(window.innerWidth - opts.expectWidth) <= 20) break;
      await frame();
    }
    // Two more frames so layout and paint settle at the new width before we read.
    await frame();
    await frame();
    return read();
  })();
}

// FR-EX-051 — hide position:fixed / position:sticky elements during the
// intermediate segments of a full-page capture so a sticky header/footer isn't
// stamped into every stitched slice. `hide:false` restores them. Self-contained
// (executeScript). CSS alone can't select by COMPUTED position, so we walk and
// tag; restoration is by the tag, so re-entrant calls are safe.
export function setFixedHidden(opts: { hide: boolean }): { hidden: number } {
  if (!opts.hide) {
    let n = 0;
    document.querySelectorAll("[data-sc-fixed]").forEach((el) => {
      (el as HTMLElement).style.removeProperty("visibility");
      el.removeAttribute("data-sc-fixed");
      n++;
    });
    return { hidden: n };
  }
  let hidden = 0;
  document.querySelectorAll("*").forEach((el) => {
    if (el.hasAttribute("data-sc-mask") || el.hasAttribute("data-sc-badge")) return; // ours — leave alone
    let pos = "";
    try {
      pos = getComputedStyle(el).position;
    } catch {
      return;
    }
    if (pos === "fixed" || pos === "sticky") {
      el.setAttribute("data-sc-fixed", "");
      (el as HTMLElement).style.setProperty("visibility", "hidden", "important");
      hidden++;
    }
  });
  return { hidden };
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
  dialogs: number;
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
    dialogs, // FR-EX-062 — the engine closes a captured modal to crawl underneath
  };
}

// FR-EX-062 — close the top-most open modal so crawling can continue underneath,
// AFTER it's been captured as its own state. Tries Escape first (the accessible
// close path most dialogs honour), then close/dismiss controls inside the dialog
// (aria-label / title / class / ×-glyph heuristics). Reports whether a modal was
// present and whether it actually went away; an unclosable one is left for the
// engine to escape by re-navigation. Self-contained (executeScript).
export function closeTopModal(): { hadModal: boolean; closed: boolean; method: string } {
  const MODAL_SEL = '[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"]';
  const visible = (el: Element): boolean => {
    let s: CSSStyleDeclaration | null = null;
    try {
      s = getComputedStyle(el);
    } catch {
      s = null;
    }
    if (s && (s.display === "none" || s.visibility === "hidden")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const topModal = (): Element | null => {
    let found: Element | null = null;
    document.querySelectorAll(MODAL_SEL).forEach((el) => {
      if (visible(el)) found = el; // last visible in document order ≈ top-most
    });
    return found;
  };
  const modal = topModal();
  if (!modal) return { hadModal: false, closed: false, method: "" };
  const stillOpen = (): boolean => topModal() !== null;

  // 1. Escape — dispatch on the document AND the modal, keydown+keyup, so a
  //    handler listening on either at either phase fires.
  for (const type of ["keydown", "keyup"] as const) {
    const ev = () =>
      new KeyboardEvent(type, {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true,
      });
    try {
      document.dispatchEvent(ev());
      modal.dispatchEvent(ev());
    } catch {
      /* KeyboardEvent unsupported — fall through to the button heuristics */
    }
  }
  if (!stillOpen()) return { hadModal: true, closed: true, method: "escape" };

  // 2. A close/dismiss control INSIDE the dialog. Match on intent (aria-label,
  //    title, class) or an ×-glyph / bare "close" label — never a random button.
  const CLOSE_HINT = /(^|\W)(close|dismiss|×|✕|✖|⨯)(\W|$)/i;
  const controls = modal.querySelectorAll(
    'button,[role="button"],a[href],[aria-label],[title],.close',
  );
  for (const c of Array.from(controls)) {
    const label = [
      c.getAttribute("aria-label"),
      c.getAttribute("title"),
      typeof c.className === "string" ? c.className : "",
      (c.textContent || "").trim(),
    ]
      .filter(Boolean)
      .join(" ");
    if (!CLOSE_HINT.test(label)) continue;
    try {
      (c as HTMLElement).click();
    } catch {
      continue;
    }
    if (!stillOpen()) return { hadModal: true, closed: true, method: "button" };
  }
  return { hadModal: true, closed: false, method: "" }; // unclosable → engine re-navigates
}

// FR-EX-033 — steady the page before the first capture of a state: kill
// animations/transitions, pause autoplaying media and CSS carousels, then wait
// for the visible images to finish loading (bounded by timeoutMs). Without this
// the same state photographs differently every visit — a mid-fade opacity, a
// half-loaded <img>, a carousel on a different slide — and two identical states
// hash apart. Self-contained (executeScript serialises it); executeScript awaits
// the returned promise. Idempotent: the <style> is keyed and only injected once.
export function freezeForCapture(opts: { timeoutMs: number; settleMs?: number }): Promise<{
  frozen: boolean;
  imagesWaited: number;
}> {
  // Horizontal scroll must be ZERO for a viewport capture. A click that used
  // scrollIntoView, or a wide element on a narrow (mobile) viewport, leaves the
  // page scrolled right — and the shot then has its whole left edge sliced off,
  // which is what made mobile captures look broken. Vertical position is left
  // alone: that IS the state being photographed.
  try {
    if (window.scrollX !== 0) window.scrollTo(0, window.scrollY);
  } catch {
    /* not scrollable */
  }
  // The freeze CSS. `animation:none` alone doesn't stop an in-progress
  // animation on some engines, so also force-finish via a negative delay and
  // pin play-state to paused. scroll-behavior:auto kills smooth-scroll so
  // scrollToY lands exactly (FR-EX-051). caret-color:transparent hides the text
  // cursor from a focused input.
  const CSS = `*,*::before,*::after{
    animation-duration:0s !important;animation-delay:-0.001s !important;
    animation-play-state:paused !important;animation-iteration-count:1 !important;
    transition-duration:0s !important;transition-delay:0s !important;
    scroll-behavior:auto !important;caret-color:transparent !important;}`;

  try {
    if (!document.getElementById("sc-freeze-style")) {
      const style = document.createElement("style");
      style.id = "sc-freeze-style";
      style.textContent = CSS;
      (document.head || document.documentElement).appendChild(style);
    }
    // Pause autoplaying media where we can (FR-EX-033 "where possible").
    document.querySelectorAll("video,audio").forEach((m) => {
      try {
        (m as HTMLMediaElement).pause();
        (m as HTMLMediaElement).autoplay = false;
      } catch {
        /* cross-origin media element — nothing we can do, skip */
      }
    });
  } catch {
    /* head not ready / CSP on inline <style> — the image wait below still runs */
  }

  // Wait for VISIBLE images to finish (max timeoutMs). Only images intersecting
  // the viewport matter for a viewport capture — a lazy <img> 5000px down would
  // otherwise burn the whole budget every state for a pixel nobody photographs.
  const pending: Promise<void>[] = [];
  const vh = window.innerHeight || 0;
  const vw = window.innerWidth || 0;
  document.querySelectorAll("img").forEach((img) => {
    const im = img as HTMLImageElement;
    if (im.complete && im.naturalWidth > 0) return;
    const r = im.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return; // not rendered
    const inView = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    if (!inView) return;
    pending.push(
      new Promise<void>((resolve) => {
        const done = (): void => resolve();
        im.addEventListener("load", done, { once: true });
        im.addEventListener("error", done, { once: true }); // a broken img must not hang the wait
      }),
    );
  });

  const imagesWaited = pending.length;
  const wait = (ms: number): Promise<void> =>
    new Promise((r) => {
      window.setTimeout(r, Math.max(0, ms));
    });

  // Images, then webfonts, then a settle pause. The old version returned
  // SYNCHRONOUSLY whenever every visible image happened to be cached
  // (imagesWaited === 0), so a page mid-entrance-animation or still swapping in
  // its webfont was photographed exactly as it was — no wait at all.
  const imagesDone: Promise<void> =
    imagesWaited === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            resolve();
          };
          const cap = window.setTimeout(finish, Math.max(0, opts.timeoutMs));
          void Promise.all(pending).then(() => {
            clearTimeout(cap);
            finish();
          });
        });

  return imagesDone
    .then(() => {
      // FOUT: text painted in the fallback face is a visibly different shot.
      const f = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
      if (!f?.ready) return undefined;
      return Promise.race([f.ready, wait(2000)]).then(() => undefined);
    })
    .then(() => wait(opts.settleMs ?? 0))
    .then(() => ({ frozen: true, imagesWaited }));
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

/** Remove all data-sc-idx marks left by discoverCandidates — including any inside
 *  open shadow roots (FR-EX-022) or same-origin iframes (FR-EX-023), which a
 *  document-level query can't see and would leave behind on the user's page. */
export function cleanupMarks(): void {
  const stack: (Document | ShadowRoot)[] = [document];
  let guard = 0;
  while (stack.length && guard++ < 5000) {
    const root = stack.pop()!;
    root.querySelectorAll("[data-sc-idx]").forEach((n) => n.removeAttribute("data-sc-idx"));
    root.querySelectorAll("*").forEach((e) => {
      const sr = (e as HTMLElement).shadowRoot;
      if (sr) stack.push(sr);
      if (e.tagName === "IFRAME") {
        try {
          const d = (e as HTMLIFrameElement).contentDocument;
          if (d) stack.push(d);
        } catch {
          /* cross-origin — nothing of ours to clean there */
        }
      }
    });
  }
}
