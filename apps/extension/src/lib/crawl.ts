// Crawl orchestrator — the real BFS crawl engine (FR-EX-030). Runs in the SERVICE
// WORKER, driving the user's CURRENT tab in place (opts.target, FR-EX-011) — no
// separate window. C-01: captureVisibleTab only sees the focused window's active
// tab, so before every capture the engine re-activates the crawl tab.
//
// It drives that tab through a breadth-first search over (state, element) pairs:
//   restore state → discover (FR-EX-020) → pick an untried, non-destructive
//   element (FR-EX-070) → safeClick (FR-EX-031) → wait for UI stability
//   (FR-EX-032) → re-fingerprint (FR-EX-040/041): new state ⇒ capture + enqueue,
//   known ⇒ edge only, unchanged ⇒ dead edge → return to the state and continue.
//
// Every queued state is `{ url, path, depth, fp }`. To revisit a state we
// navigate to its route-addressable `url` and replay its short click `path`
// (bounded restoration — a minimal FR-EX-061), verifying the fingerprint.
//
// Limits (FR-EX-030): maxScreens, maxDurationMin end the run as
// `completed (limit-reached)`; maxDepth prunes enqueue. An empty queue ⇒
// `completed`.
//
// Resilient to SW eviction (FR-EX-080, C-03, EC-012): every state transition
// checkpoints the queue/visited/tried sets, click paths and run config via
// ./checkpoint, so a woken worker can rebuild the run by calling run() again
// with the checkpoint as `resume` (see resumeCrawl in the background worker).
// The click path is write-ahead logged — see `checkpointNow` at the click site.

import {
  applyMasks,
  applyRunBadge,
  cleanupMarks,
  clickCandidate,
  closeTopModal,
  discoverCandidates,
  extractStateSignature,
  freezeForCapture,
  getLocation,
  installNetworkCounter,
  neutralizeDialogsInPage,
  removeMasks,
  scrollToY,
  settleAfterViewportChange,
  setFixedHidden,
  setRunBadgeVisible,
  waitForStable,
  type DiscoverResult,
  type InjectedCandidate,
} from "../content/crawl-inject";
import { computeFingerprint, normalizeUrl, sha256Hex } from "./fingerprint";
import { DEFAULT_DESTRUCTIVE_BLOCKLIST } from "@snapcrawl/shared/constants";
import type {
  CaptureMeta,
  CrawlConfig,
  EdgeInput,
  ElementDescriptor,
  Limit,
  SessionEndReason,
  SessionLogInput,
  SessionOverrides,
  SessionStats,
  SessionStatus,
} from "@snapcrawl/shared";
import { resolveLimit } from "@snapcrawl/shared";
import { edgeKind } from "./upload";
import {
  getCrawlShotCount,
  putCrawlMobileShot,
  putCrawlShot,
  resetCrawlShots,
} from "./capture-sink";
import { putCrawlError, resetCrawlErrors } from "./error-sink";
import {
  CHECKPOINT_VERSION,
  clearCheckpoint,
  deserializeLogBuffer,
  getSessionNonce,
  serializeLogBuffer,
  writeCheckpoint,
  type CrawlCheckpoint,
} from "./checkpoint";
import {
  createSession,
  setRunAbortSignal,
  updateSession,
  uploadCapture,
  uploadEdges,
  uploadLogs,
} from "./crawl-upload";
import { effectiveAllowedDomains, isInScope } from "./scope";
import { crawlOrigins, injectionErrorMessage } from "./host-access";

/** Default run-override values surfaced in the popup. */
export const DEFAULT_MAX_SCREENS = 40;
export const DEFAULT_MAX_DEPTH = 4;
export const DEFAULT_MAX_MINUTES = 10;

// FR-EX-090 — emulated phone. DPR 3 matches the class of device the default
// 390×844 viewport describes, so a mobile shot is 1170×2532 real pixels.
const MOBILE_DPR = 3;
/** Hard ceiling on any single chrome.debugger command.
 *
 *  sendCommand has no timeout of its own, and several CDP commands need the
 *  page's renderer to respond — so a busy or wedged renderer can leave the
 *  promise pending FOREVER. That is not hypothetical: it is what stalled the
 *  crawl a couple of states in. The whole mobile pass is optional, so bounding
 *  each command and giving up is always better than hanging the run. */
const CDP_TIMEOUT_MS = 8000;
const MOBILE_SETTLE_MS = 700; // max wait for the page to re-lay-out at phone width
const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36";

/** Stall watchdog (see `emit`). A run silent this long is wedged, not working. */
const STALL_TIMEOUT_MS = 10 * 60_000;
const STALL_CHECK_MS = 30_000;

const CAPTURE_SPACING_MS = 600; // C-01 / FR-EX-050: ≥ 600 ms between captures.
const IMAGE_WAIT_MS = 3000; // FR-EX-033: cap on waiting for visible images to load.
const MAX_FULLPAGE_SEGMENTS = 10; // FR-EX-051 / EC-007: cap scroll-and-stitch segments.

/**
 * FR-EX-051 — stitch viewport segments into one tall PNG on an OffscreenCanvas.
 * Runs in the service worker, where OffscreenCanvas / createImageBitmap /
 * FileReader all exist. `y` is each segment's CSS-px scroll offset; the device
 * pixel ratio is recovered from the first bitmap's width so the physical-pixel
 * shots line up. Returns a PNG data URL, or undefined if nothing decoded.
 */
async function stitchSegments(
  segments: { dataUrl: string; y: number }[],
  innerWidth: number,
): Promise<string | undefined> {
  const decoded: { bmp: ImageBitmap; y: number }[] = [];
  for (const s of segments) {
    try {
      const blob = await (await fetch(s.dataUrl)).blob();
      decoded.push({ bmp: await createImageBitmap(blob), y: s.y });
    } catch {
      /* a segment that won't decode is dropped; the rest still stitch */
    }
  }
  if (decoded.length === 0) return undefined;
  // captureVisibleTab returns physical pixels: width = CSS innerWidth × DPR.
  const dpr = innerWidth > 0 ? decoded[0]!.bmp.width / innerWidth : 1;
  const w = decoded[0]!.bmp.width;
  const h = Math.max(...decoded.map((d) => Math.round(d.y * dpr) + d.bmp.height));
  try {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    // Draw in order; a later segment overwrites the overlap with the SAME pixels,
    // so the seam is exact and the short last segment lands at its true offset.
    for (const d of decoded) ctx.drawImage(d.bmp, 0, Math.round(d.y * dpr));
    const out = await canvas.convertToBlob({ type: "image/png" });
    return await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as string);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(out);
    });
  } finally {
    for (const d of decoded) d.bmp.close();
  }
}
const STABILITY_QUIET_MS = 500; // FR-EX-032
const STABILITY_TIMEOUT_MS = 8000; // FR-EX-032
const DEFAULT_CLICK_DELAY_MS = 250; // FR-EX-032 clickDelayMs
const NAV_READY_TIMEOUT_MS = 15000; // max wait for a navigation to settle
const NAV_NUDGE_MS = 120; // let a click-triggered navigation commit before waiting
const EXPAND_GUARD = 500; // max elements examined per state (runaway backstop)
const HEARTBEAT_MS = 15000; // session heartbeat cadence (FR-EX-011)
const DIALOG_GUARD_ID = "sc-dialog-guard"; // document_start beforeunload guard (FR-EX-073)

export type CrawlReason =
  | "completed" // queue drained
  | "limit-reached" // maxScreens / maxDurationMin (FR-EX-030)
  | "cancelled" // user stopped
  | "no-tab" // no injectable active tab
  | "error";

export interface CrawlOptions {
  /** null = unlimited. Resolved to Infinity once inside run(); Infinity itself
   *  never travels — it does not survive JSON. */
  maxScreens: Limit;
  maxDepth: Limit;
  maxDurationMin: Limit;
  clickDelayMs?: number;
  safeMode: boolean;
  blocklist: string[];
  fullPage: boolean;
  /** Domains the crawl may touch (FR-EX-010/071); [] ⇒ derive from the start URL. */
  allowedDomains?: string[];
  /** Elements masked with opaque overlays before each capture (FR-EX-053). */
  maskSelectors?: string[];
  /** Never clicked (FR-EX-026). CSS selectors; a child of a match is excluded too. */
  excludeSelectors?: string[];
  /** Never-clicked LINKS (FR-EX-026), as regexes — matching the API's own validation. */
  excludeUrlPatterns?: string[];
  /** Allow clicking form submits (FR-EX-034). Off unless the project opts in. */
  clickSubmitEmptyForms?: boolean;
  /** FR-EX-035 — fill a form's empty fields with dummy presets before its submit
   *  is clicked. Only meaningful when clickSubmitEmptyForms is also on. */
  formFillDummyData?: boolean;
  /** FR-EX-052 — capture full-page via chrome.debugger/CDP (pixel-perfect) rather
   *  than scroll-and-stitch. Falls back to scroll-and-stitch if it can't attach. */
  proCaptureMode?: boolean;
  /** FR-EX-033 — pause after settling, before the shutter (ms). */
  captureSettleMs?: number;
  /** FR-EX-090 — which device this whole run captures as. "mobile" emulates a
   *  phone for the ENTIRE crawl: the debugger attaches once at the start and
   *  detaches at the end, so discovery, clicking and capture all happen against
   *  the mobile layout. One run, one device — never both in the same run. */
  captureMode?: "desktop" | "mobile";
  mobileViewport?: { width: number; height: number };
  /** Keep at most this many of each repeated look-alike (FR-EX-025); default 2. */
  siblingCollapseLimit?: number;
  /** URL substrings that mean the crawl hit a login/logout page (FR-EX-076). */
  loginUrlPatterns?: string[];
  /** When set (paired), a backend session is created and captures upload (FR-EX-011/081). */
  projectId?: string;
  sessionOverrides?: SessionOverrides;
  /** The current tab to drive in place (FR-EX-011). Falls back to the active tab. */
  target?: { tabId: number; windowId: number };
}

/** Per-run overrides the popup exposes on top of the project config.
 *
 *  The three limit fields are GONE. A crawl runs until the user stops it, so
 *  there is no limit state for the popup to hold, seed from a project, send to
 *  the backend, or clamp — which also removes the bug where switching project
 *  re-seeded a finite ceiling onto a run the user expected to be unbounded. */
export interface RunOverrides {
  fullPage: boolean;
  /** FR-EX-052 — pro (CDP) full-page capture; shows the debugger banner. */
  proCaptureMode: boolean;
  /** FR-EX-090 — capture this run as a desktop or a phone. */
  captureMode: "desktop" | "mobile";
}

/**
 * Build the crawl options from a project's config (FR-EX-002) plus per-run
 * overrides and the Safe-mode toggle. The blocklist, clickDelay and the three
 * limits come from the project config; unpaired runs are unlimited. Pure.
 */
export function configToRunOptions(
  config: CrawlConfig | null,
  overrides: RunOverrides,
  safeMode: boolean,
): CrawlOptions {
  return {
    // null = unlimited. Unpaired has no project config, so it is unlimited too.
    maxScreens: config ? config.maxScreens : null,
    maxDepth: config ? config.maxDepth : null,
    maxDurationMin: config ? config.maxDurationMin : null,
    clickDelayMs: config?.clickDelayMs,
    safeMode,
    blocklist: config?.destructiveTextBlocklist ?? [...DEFAULT_DESTRUCTIVE_BLOCKLIST],
    fullPage: overrides.fullPage,
    maskSelectors: config?.maskSelectors ?? [],
    allowedDomains: config?.allowedDomains ?? [],
    excludeSelectors: config?.excludeSelectors ?? [], // FR-EX-026
    excludeUrlPatterns: config?.excludeUrlPatterns ?? [], // FR-EX-026
    // FR-EX-034 — default off, per the spec. The unpaired (config === null) path
    // therefore skips every form submit, which is the safe direction.
    clickSubmitEmptyForms: config?.clickSubmitEmptyForms ?? false,
    // FR-EX-035 — default off; a no-op unless clickSubmitEmptyForms is also on.
    formFillDummyData: config?.formFillDummyData ?? false,
    // FR-EX-052 — the per-run toggle (seeded from the project's proCaptureMode).
    proCaptureMode: overrides.proCaptureMode,
    // FR-EX-090 — the per-run device (seeded from the project's captureMobile).
    captureMode: overrides.captureMode,
    mobileViewport: config?.mobileViewport ?? { width: 430, height: 932 },
    captureSettleMs: config?.captureSettleMs ?? 2000,
    // FR-EX-025 — default 2 (schema default), so an unpaired run still collapses.
    siblingCollapseLimit: config?.siblingCollapseLimit ?? 2,
    // FR-EX-076 — spec defaults when unset/unpaired.
    loginUrlPatterns: config?.loginUrlPatterns ?? ["/login", "/signin", "/logout"],
  };
}

/** FR-EX-076 — does `url` look like a login/logout page? Case-insensitive
 *  substring match against the (configurable) patterns. Pure. */
export function matchesAuthUrl(url: string, patterns: string[] | undefined): string | null {
  if (!patterns || patterns.length === 0) return null;
  const u = url.toLowerCase();
  for (const p of patterns) {
    const needle = p.trim().toLowerCase();
    if (needle && u.includes(needle)) return p;
  }
  return null;
}

export interface CrawlProgress {
  screens: number;
  states: number;
  depth: number;
  queue: number;
  pages: number;
  errors: number;
  currentUrl: string;
  phase: string;
  /** FR-EX-023 / C-04 — cross-origin (or too-deeply-nested) iframe regions the
   *  crawl couldn't see into, run-total. Surfaced so the popup can say plainly
   *  "N regions skipped" rather than the coverage gap being silent. */
  unreachableRegions: number;
}

export interface CrawlResult {
  /** Number of screenshots captured (stored via the sink, not held in memory). */
  captures: number;
  reason: CrawlReason;
  states: number;
  pages: number;
  edges: number;
  deadEdges: number;
  /** Branches the engine gave up on (FR-EX-084). Non-zero means the run covered
   *  less of the site than it could have — the number that tells you whether a
   *  thin crawl is a small site or a broken crawler. */
  abandoned: number;
  /** How many captures were uploaded to the backend (0 when unpaired). */
  uploaded: number;
  /** FR-EX-023 / C-04 — cross-origin / too-deep iframe regions left uncrawled. */
  unreachableRegions: number;
  sessionId: string | null;
  error?: string;
}

/** A recorded click, enough to re-find the element on replay (FR-EX-061).
 *  Every field is a matching signal — see matchCandidate. */
export interface ClickStep {
  /** The FR-EX-024 fingerprint: robust path + hash(tag, role, text). */
  key: string;
  tag: string;
  role: string | null;
  text: string;
  href: string | null;
  /** The element's own unique anchor (data-testid/#id/aria-label), if any. */
  anchor?: string | null;
  /** The robust CSS path — a weaker, positional signal than `anchor`. */
  selector?: string;
  /** FR-EX-061 — the record (row/card) this control belonged to. Re-anchors the
   *  match to the right row after a table re-renders and reorders. */
  containerKey?: string | null;
}

/** A node in the BFS frontier.
 *
 *  Two independent ways back (FR-EX-061), because one is not enough: `url` is the
 *  direct-navigation candidate, and `replayFrom` + `path` is the click path that
 *  actually produced this state. A URL change does NOT prove a state is
 *  reproducible by navigating to that URL — client-side routes, query-string
 *  variants and post-interaction DOM all change the URL while leaving the state
 *  unreachable by a fresh load. Measured on a real Next.js app: four of five
 *  abandoned branches were exactly that. So the path is always retained as the
 *  fallback, even when the route changed.
 */
export interface QueuedState {
  /** Direct-navigation candidate — tried first, and usually right. */
  url: string;
  /** Where `path` must be replayed FROM: the nearest route-addressable ancestor. */
  replayFrom: string;
  /** How this state was actually reached, from `replayFrom`. Never discarded. */
  path: ClickStep[];
  depth: number;
  fp: string;
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/**
 * First candidate that is actionable for this state: not destructive (in safe
 * mode) and not already tried as a (stateFp, element) pair. Pure.
 */
export function pickNextForState(
  candidates: InjectedCandidate[],
  triedPairs: Set<string>,
  stateFp: string,
  safeMode: boolean,
  clickSubmitEmptyForms = false,
  clicksByKey?: Map<string, number>,
): InjectedCandidate | null {
  for (const c of candidates) {
    if (safeMode && c.destructive) continue;
    // FR-EX-026 — "shall never be clicked". Note the absence of a safeMode
    // condition, unlike the line above: Safe-mode is the tester's full-test
    // escape hatch for the blocklist, but an exclude rule has no escape hatch.
    if (c.excluded) continue;
    // FR-EX-034 — skip form submits unless the project opted in, and skip them
    // even then if they're destructive ("unless they match no destructive rule
    // AND ..."). That second clause is why this can't be folded into the
    // safeMode check above: a destructive submit stays blocked with Safe-mode
    // off and the flag on.
    if (c.submit && (!clickSubmitEmptyForms || c.destructive)) continue;
    // FR-EX-075 / EC-006 — never click a native-dialog trigger (a file picker
    // above all). Like exclude, no safeMode escape hatch: a native dialog the
    // crawler can't dismiss stalls the whole loop until a human acts.
    if (c.nativeDialog) continue;
    // FR-EX-025 — a look-alike beyond the collapse limit. Not a safety gate: it
    // trades coverage of near-identical siblings for budget, and the skip is
    // recorded (skipped-similar) so the omission is visible, never silent.
    if (c.similar) continue;
    if (triedPairs.has(pairKey(stateFp, c.key))) continue;
    // The frontier brake. triedPairs is keyed PER STATE, so when a click changes
    // the DOM signature the same element on the resulting state is a fresh
    // untried pair and gets clicked again — forever. A calendar's "next month"
    // mints a new heading (and so a new fingerprint) on every press; "load more"
    // changes the node count; a pager changes both. maxScreens used to be the
    // only thing that ended those loops, so with it gone this cap is what makes
    // an unlimited crawl terminate on a real site.
    //
    // Deliberately GLOBAL and keyed on the element alone: that is what makes it
    // invariant to fingerprint churn, which is exactly the property a per-URL or
    // per-template cap lacks (a client-routed SPA keeps one URL for the whole
    // app, so those caps either never fire or truncate the crawl to nothing).
    if (clicksByKey && (clicksByKey.get(c.key) ?? 0) >= MAX_CLICKS_PER_ELEMENT) continue;
    return c;
  }
  return null;
}

/** How many times one element may be clicked across the WHOLE run, however many
 *  distinct states it appears in. Generous enough that a legitimately reusable
 *  control (a nav link seen from five pages) is unaffected; low enough that an
 *  unbounded generator stops. */
export const MAX_CLICKS_PER_ELEMENT = 5;

export function pairKey(stateFp: string, elementKey: string): string {
  return `${stateFp}::${elementKey}`;
}

/**
 * Did Chrome refuse a screenshot for lack of permission, rather than failing for
 * a transient reason (rate limit, lost focus)? Chrome's own words are
 * "Either the '<all_urls>' or 'activeTab' permission is required."
 *
 * This matters twice over: a denial is permanent for the run, so retrying it wastes
 * a backoff on every single state; and it has a specific fix the user can act on,
 * unlike "the window lost focus". Pure.
 */
export function isCaptureDenied(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("all_urls") || m.includes("activetab") || m.includes("permission is required");
}

/** Text with digit runs collapsed: "Projects (3)" and "Projects (4)" are the same
 *  control one render apart, not two controls. A weak signal on its own — every
 *  page number in a pager collapses to the same thing — so it never decides a
 *  match by itself (see scoreCandidate). Pure. */
export function digitless(s: string): string {
  return s.replace(/\d+/g, "#");
}

/** Minimum score for the fuzzy tier. Set so that no combination of WEAK signals
 *  can reach it: at least one of anchor/href/text must agree. */
export const MATCH_MIN_SCORE = 4;

/**
 * How strongly does `c` look like the element `step` recorded? 0 ⇒ not a match
 * at any price. Pure — the whole point is that the fuzzy tier is inspectable
 * without a browser.
 *
 * The weights encode how much each signal survives a re-render:
 *   anchor  — an author-written data-testid/#id. Survives almost anything.
 *   href    — a link's destination. Survives re-render; changes on pagination.
 *   text    — the label. Survives layout churn; changes with counts/i18n.
 *   path    — position. Survives text churn; changes when the tree moves.
 * Different signals fail in different ways, which is why the sum beats any one.
 */
export function scoreCandidate(c: InjectedCandidate, step: ClickStep): number {
  if (c.tag !== step.tag) return 0; // a control does not change tag; never cross that line
  let s = 0;
  if (step.anchor && c.anchor === step.anchor) s += 6;
  // Record identity (FR-EX-061): the ONE signal that survives a table reorder,
  // where position moves and the button's own descriptor is identical on every
  // row. Weighted near anchor so "the Deactivate in alice's row" re-anchors.
  if (step.containerKey && c.containerKey === step.containerKey) s += 5;
  if (step.href && c.href === step.href) s += 5;
  if (step.text && c.text === step.text) s += 4;
  else if (step.text && c.text && digitless(c.text) === digitless(step.text)) s += 2;
  if (step.selector && c.selector === step.selector) s += 2;
  if ((c.role ?? "") === (step.role ?? "")) s += 1;
  return s;
}

/**
 * Re-find a recorded element among freshly-discovered candidates (FR-EX-061).
 * Null ⇒ replay diverged, and the caller abandons the branch.
 *
 * Four escalating tiers, because the previous two were too brittle for a real
 * SPA: exact key, then identical descriptor. Both compare the WHOLE identity, so
 * one changed character anywhere — a re-ordered node moving the structural path,
 * a count ticking from (3) to (4) — dropped the match to null and abandoned the
 * subtree. On our own Next.js panel that was every remaining abandonment.
 *
 * Being wrong here is bounded: a mismatched element fails the fingerprint check
 * after the click and the branch is abandoned anyway — the same outcome as no
 * match, plus one wasted click on an element that has already passed the
 * destructive/exclude/submit gates. Ambiguity is NOT bounded, so ties never win.
 * Pure.
 */
export function matchCandidate(
  candidates: InjectedCandidate[],
  step: ClickStep,
): InjectedCandidate | null {
  // tier 1 — the fingerprint (FR-EX-024). Unchanged page ⇒ decided here. But the
  // key embeds the POSITIONAL path, and for an anchor-less repeated record that
  // path names the position, not the element: after a reorder, position N's key
  // belongs to whatever row moved there. So when the recorded control carried a
  // record key, a key match whose record DISAGREES is a positional collision, not
  // the element — skip it and let the record-key tiers re-anchor (FR-EX-061).
  for (const c of candidates) {
    if (c.key !== step.key) continue;
    if (step.containerKey && c.containerKey && c.containerKey !== step.containerKey) continue;
    return c;
  }

  // tier 2 — the element's own anchor. An author-written data-testid outranks
  // everything else we know: it exists precisely to survive re-renders.
  if (step.anchor) {
    const hits = candidates.filter((c) => c.anchor === step.anchor);
    if (hits.length === 1) return hits[0]!;
  }

  // tier 3 — identical descriptor. When repeated (the same button on every row),
  // disambiguate by RECORD identity first — the row's own key survives a reorder,
  // whereas the structural path is exactly what a reorder breaks. Only if the
  // record key can't decide do we fall back to the (positional) path, then first.
  const same = candidates.filter(
    (c) =>
      c.tag === step.tag &&
      (c.role ?? "") === (step.role ?? "") &&
      c.text === step.text &&
      (c.href ?? "") === (step.href ?? ""),
  );
  if (same.length === 1) return same[0]!;
  if (same.length > 1) {
    if (step.containerKey) {
      const byRecord = same.filter((c) => c.containerKey === step.containerKey);
      if (byRecord.length === 1) return byRecord[0]!; // FR-EX-061 — re-anchored to the row
    }
    return same.find((c) => c.selector === step.selector) ?? same[0]!;
  }

  // tier 4 — best scored. Requires a strong signal (MATCH_MIN_SCORE) AND a
  // strictly-better winner: if two candidates look equally like the recorded
  // element, we genuinely don't know which, and guessing would click a real
  // element on a real site for a coin-flip.
  let best: InjectedCandidate | null = null;
  let bestScore = 0;
  let runnerUp = 0;
  for (const c of candidates) {
    const s = scoreCandidate(c, step);
    if (s > bestScore) {
      runnerUp = bestScore;
      bestScore = s;
      best = c;
    } else if (s > runnerUp) {
      runnerUp = s;
    }
  }
  if (best && bestScore >= MATCH_MIN_SCORE && bestScore > runnerUp) return best;
  return null;
}

/**
 * Same-window crawl (FR-EX-011): navigate the current tab to the start URL only
 * when a start URL is given AND the tab isn't already there. The popup normally
 * passes the tab's own URL, so this is usually false (no reload). Pure.
 */
export function shouldNavigateInPlace(currentUrl: string, startUrl: string): boolean {
  if (!startUrl) return false;
  return currentUrl !== startUrl;
}

/** FR-EX-030 limits: screen budget or time budget reached ⇒ "limit-reached". Pure. */
export function limitReason(s: {
  shots: number;
  maxScreens: number;
  elapsedMs: number;
  maxDurationMs: number;
}): "limit-reached" | null {
  if (s.shots >= s.maxScreens) return "limit-reached";
  if (s.elapsedMs >= s.maxDurationMs) return "limit-reached";
  return null;
}

/** FR-EX-030: may a state at `parentDepth` enqueue children (child ≤ maxDepth)? Pure. */
export function canDescend(parentDepth: number, maxDepth: number): boolean {
  return parentDepth < maxDepth;
}

/**
 * FR-EX-032 stability decision — mirrors the injected `waitForStable`: settled
 * only when the DOM has been quiet ≥ threshold AND no requests are in flight. Pure.
 */
export function stabilitySettled(s: {
  inflight: number;
  quietElapsedMs: number;
  quietThresholdMs: number;
}): boolean {
  return s.inflight <= 0 && s.quietElapsedMs >= s.quietThresholdMs;
}

/**
 * FR-EX-083 / EC-019 — does this scripting/tabs error mean the target frame or
 * tab is GONE (a crashed "Aw, Snap!" renderer, a closed tab, a detached frame)
 * rather than a transient injection failure? Used as a last-resort belt so the
 * run never surfaces Chrome's raw "Frame with ID 0 was removed." string. Pure.
 */
export function isDeadTabError(message: string): boolean {
  const m = (message || "").toLowerCase();
  return (
    m.includes("frame with id") || // "Frame with ID 0 was removed." (crashed renderer)
    m.includes("no frame with id") ||
    m.includes("frame was removed") ||
    m.includes("target frame detached") ||
    m.includes("no tab with id") ||
    m.includes("tab was closed") ||
    m.includes("tab was discarded") ||
    m.includes("target closed") ||
    m.includes("back/forward cache")
  );
}

// ── Injection plumbing ──────────────────────────────────────────────────────

// `setTimeout` (not window.setTimeout) so this runs in the service worker too.
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const EXEC_TIMEOUT_MS = 10000; // an injection blocked by a native dialog can't hang the loop forever

/** Resolve `p`, or `undefined` if it doesn't settle within `ms` (never hangs). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

async function execScript<A, R>(
  tabId: number,
  func: (arg: A) => R,
  arg?: A,
): Promise<Awaited<R> | undefined> {
  try {
    const results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        func: func as (...a: unknown[]) => unknown,
        args: arg === undefined ? [] : [arg],
      }),
      EXEC_TIMEOUT_MS,
    );
    return results?.[0]?.result as Awaited<R> | undefined;
  } catch {
    // A rejected injection — frame removed on a crashed renderer, closed tab,
    // restricted page — is best-effort like a timeout and must NEVER abort the
    // crawl (FR-EX-082/083). Every caller already handles `undefined`; a genuine
    // renderer crash is detected explicitly via `ensureTabAlive` (EC-019).
    return undefined;
  }
}

/** Same as `execScript`, but in the page's MAIN world (network monkey-patch). */
async function execScriptMain<A, R>(
  tabId: number,
  func: (arg: A) => R,
  arg?: A,
  allFrames = false,
): Promise<Awaited<R> | undefined> {
  try {
    const results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, allFrames },
        world: "MAIN",
        func: func as (...a: unknown[]) => unknown,
        args: arg === undefined ? [] : [arg],
      }),
      EXEC_TIMEOUT_MS,
    );
    return results?.[0]?.result as Awaited<R> | undefined;
  } catch {
    return undefined; // best-effort — see `exec` (FR-EX-082/083)
  }
}

// ── Controller ──────────────────────────────────────────────────────────────

export class CrawlController {
  private _cancelled = false;
  private _paused = false;
  private _pausedAt: number | null = null;
  private _pausedTotalMs = 0;

  // FR-EX-012 — Stop is a HARD kill: clicking and capturing must halt within 2 s.
  // The flag alone isn't enough — it's only read between operations, and a single
  // in-flight wait (an 8 s stability wait, a 15 s nav wait, a 3 s image wait, a
  // 10 s exec timeout) can outlast the 2 s bound. This promise resolves the
  // instant cancel() is called, so every wait in run() can race against it and
  // give up immediately instead of running to its own timeout.
  private _cancelSignal: Promise<void>;
  private _fireCancel!: () => void;
  /** Aborts in-flight fetches on Stop. The upload path is NOT covered by
   *  raceCancel (it is neither sleep nor exec), so without this a stalled socket
   *  outlives Stop indefinitely — see setRunAbortSignal in crawl-upload.ts. */
  private _abort = new AbortController();
  /** Who ended the run. The off-scope pullback self-cancels (see the pullback
   *  site), and that was indistinguishable from a user Stop at the reason mapping
   *  below. Noise when `cancelled` was rare; now that Stop is the normal ending it
   *  is the difference between a diagnosable run and an unfalsifiable one. */
  private _cancelSource: "user" | "self:off-scope" | "self:stalled" = "user";

  constructor() {
    this._cancelSignal = new Promise<void>((resolve) => {
      this._fireCancel = resolve;
    });
  }

  cancel(source: "user" | "self:off-scope" | "self:stalled" = "user"): void {
    if (!this._cancelled) this._cancelSource = source; // first cancel wins
    this._cancelled = true;
    this._fireCancel(); // wake every in-flight wait NOW (FR-EX-012)
    this._abort.abort(); // and kill any in-flight upload
  }
  /** Signal handed to the upload transport for the duration of the run. */
  protected abortSignal(): AbortSignal {
    return this._abort.signal;
  }
  protected get cancelSource(): "user" | "self:off-scope" | "self:stalled" {
    return this._cancelSource;
  }
  /** Resolves when the run is cancelled — the reset every wait in run() races. */
  protected cancelSignal(): Promise<void> {
    return this._cancelSignal;
  }
  pause(): void {
    if (this._paused) return;
    this._paused = true;
    this._pausedAt = Date.now();
  }
  resume(): void {
    if (!this._paused) return;
    this._paused = false;
    if (this._pausedAt !== null) {
      this._pausedTotalMs += Date.now() - this._pausedAt;
      this._pausedAt = null;
    }
  }
  get isPaused(): boolean {
    return this._paused;
  }
  /** Wall-clock time spent paused so far, including any pause in progress. */
  private pausedMs(): number {
    return this._pausedTotalMs + (this._pausedAt !== null ? Date.now() - this._pausedAt : 0);
  }

  private async waitWhilePaused(): Promise<void> {
    while (this._paused && !this._cancelled) await delay(150);
  }

  /**
   * Drive a crawl to completion.
   *
   * `resume` (FR-EX-080) rebuilds a run whose service worker was evicted: every
   * local below is seeded from it instead of from scratch, the seed capture and
   * the sink resets are skipped, and the first dequeued state is restored rather
   * than assumed to be on screen. The caller is responsible for vetting the
   * checkpoint first (version/nonce/staleness/tab — see resumeVeto).
   */
  async run(
    opts: CrawlOptions,
    onProgress: (p: CrawlProgress) => void,
    resume?: CrawlCheckpoint,
  ): Promise<CrawlResult> {
    const clickDelayMs = opts.clickDelayMs ?? DEFAULT_CLICK_DELAY_MS;
    // The ONE place null becomes Infinity. Everything downstream — limitReason,
    // canDescend — keeps comparing plain numbers and needs no edit: `n >= Infinity`
    // is false forever and `n < Infinity` is true forever. Infinity stays inside
    // this function; it is never checkpointed, messaged or uploaded.
    const maxScreens = resolveLimit(opts.maxScreens);
    const maxDepth = resolveLimit(opts.maxDepth);
    const maxDurationMs = resolveLimit(opts.maxDurationMin) * 60_000;

    // Hand the transport this run's abort signal so Stop cuts in-flight uploads
    // (FR-EX-012). Cleared in the finally, before the finalisation tail.
    setRunAbortSignal(this.abortSignal());

    // FR-EX-012 — every wait below races the cancel signal, so Stop unblocks the
    // loop within milliseconds instead of at the wait's own timeout (up to 15 s).
    // `sleep`, `exec`, `execMain` shadow the module helpers for the whole run:
    //   - sleep(ms)  resolves early on cancel.
    //   - exec/execMain resolve `undefined` on cancel while the page-side script
    //     keeps running harmlessly; every caller already treats undefined as a
    //     best-effort miss (FR-EX-082/083), so a cancelled exec is just a miss.
    // The page keeps whatever it was doing, but the CONTROLLER stops driving it —
    // which is exactly "clicking and capturing halt", since neither can be
    // initiated without an exec. Cleanup in the finally uses the RAW execScript so
    // it runs to completion even after cancel (the marks must come off the page).
    const cancelSignal = this.cancelSignal();
    const raceCancel = <T>(p: Promise<T>): Promise<T | undefined> =>
      Promise.race([p, cancelSignal.then(() => undefined)]);
    const sleep = (ms: number): Promise<void> => raceCancel(delay(ms)).then(() => undefined);
    const exec = <A, R>(
      t: number,
      func: (arg: A) => R,
      arg?: A,
    ): Promise<Awaited<R> | undefined> => raceCancel(execScript<A, R>(t, func, arg));
    const execMain = <A, R>(
      t: number,
      func: (arg: A) => R,
      arg?: A,
      allFrames = false,
    ): Promise<Awaited<R> | undefined> => raceCancel(execScriptMain<A, R>(t, func, arg, allFrames));

    const empty = (error?: string): CrawlResult => ({
      captures: 0,
      reason: "no-tab",
      states: 0,
      pages: 0,
      edges: 0,
      deadEdges: 0,
      abandoned: 0,
      uploaded: 0,
      unreachableRegions: 0,
      sessionId: null,
      ...(error ? { error } : {}),
    });

    // A run that can't even start. On the resume path the checkpoint has to go
    // with it: these returns happen before the try/finally below, so nothing
    // else would clear it and the alarm would retry the same corpse every 30 s
    // forever.
    const bail = async (error?: string): Promise<CrawlResult> => {
      if (resume) await clearCheckpoint();
      return empty(error);
    };

    // Drive the current tab (FR-EX-011). Only falls back to querying the active
    // tab if no target was given (legacy path; the SW always passes one).
    let tabId: number;
    let windowId: number;
    if (opts.target) {
      tabId = opts.target.tabId;
      windowId = opts.target.windowId;
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return await bail();
      tabId = tab.id;
      windowId = tab.windowId;
    }

    let loc: { url: string; origin: string } | undefined;
    try {
      loc = await exec(tabId, getLocation);
    } catch {
      loc = undefined;
    }
    if (!loc) {
      // Injection failed. Read the tab URL (no injection needed) to report the
      // real reason: a restricted scheme vs. missing host access on a normal site.
      let tabUrl = "";
      try {
        tabUrl = (await chrome.tabs.get(tabId)).url ?? "";
      } catch {
        /* ignore */
      }
      return await bail(injectionErrorMessage(tabUrl));
    }

    // FR-EX-010/071 — the domains this run may touch. Empty config ⇒ confine to
    // the start URL's host so a crawl never wanders off-site.
    //
    // A resume reuses the RESOLVED scope verbatim and never re-derives it: that
    // fallback keys off the CURRENT url's host, and after an eviction the tab may
    // have drifted (a redirect, or the user navigating) — re-deriving would
    // silently widen the crawl's scope to wherever it happened to land.
    const scope = resume ? resume.scope : effectiveAllowedDomains(opts.allowedDomains, loc.url);
    // Authoritative scope gate: never seed/capture an off-scope tab, even if the
    // popup Start-gate was stale (the tab redirected off-scope while it was open).
    // Skipped on resume — an off-scope tab there isn't an error, it's just drift,
    // and restore() navigates back into scope before anything is clicked.
    if (!resume && !isInScope(loc.url, scope)) {
      return empty("The active tab isn't in this project's allowed domains — open an in-scope page.");
    }

    // ── Run state ────────────────────────────────────────────────────────────
    // Every local below is checkpointed by snapshot() and seeded from `resume`
    // (FR-EX-080). Keep them in this one block: a local that snapshot() forgets
    // silently resets itself on every eviction.
    const visitedStates = new Set<string>(resume?.visitedStates ?? []); // fingerprints captured (FR-EX-041)
    const triedPairs = new Set<string>(resume?.triedPairs ?? []); // `${stateFp}::${elementKey}` (never re-click)
    // Whole-run click ledger keyed on the ELEMENT only (see MAX_CLICKS_PER_ELEMENT).
    // Checkpointed as pairs so it survives an eviction — a ledger that resets on
    // resume would let an unbounded generator start over.
    const clicksByKey = new Map<string, number>(resume?.clicksByKey ?? []);
    const pages = new Set<string>(resume?.pages ?? []);
    const edgeBuffer: EdgeInput[] = resume ? [...resume.edgeBuffer] : []; // buffered edges → /ext/edges (FR-BE-045)
    let errors = resume?.errors ?? 0;
    let edges = resume?.edges ?? 0;
    let deadEdges = resume?.deadEdges ?? 0;
    // FR-EX-084 — branches the engine gave up on. Counted, not just logged: "some
    // warnings in the log" is an argument, "this run abandoned 7 branches" is a
    // measurement, and the difference decides whether a thin crawl means a small
    // site or a broken crawler.
    let abandoned = resume?.abandoned ?? 0;
    let unreachableRegions = resume?.unreachableRegions ?? 0; // FR-EX-023 — cross-origin/too-deep frames
    // The sink's own count — not a checkpointed counter — is the source of truth
    // for the next shot's sequence: putCrawlShot advances it in the same write,
    // so it can't disagree with the stored shots and overwrite one.
    let captureCount = resume ? await getCrawlShotCount() : 0;
    let uploaded = resume?.uploaded ?? 0;
    let duplicatesSkipped = resume?.duplicatesSkipped ?? 0;
    let maxDepthReached = resume?.maxDepthReached ?? 0;
    let currentUrl = resume?.currentUrl ?? loc.url;
    let currentDepth = resume?.currentDepth ?? 0;
    let lastCaptureAt = 0; // any eviction gap already exceeds CAPTURE_SPACING_MS
    let sessionId: string | null = resume?.sessionId ?? null;
    let uploadsSuspended = resume?.uploadsSuspended ?? false;
    let tabClosed = false; // EC-019 — set if the user closes the crawl tab mid-run
    let tabCrashed = false; // EC-019 / FR-EX-083 — set if the renderer crashes ("Aw, Snap!")
    let crashRecoveries = resume?.crashRecoveries ?? 0; // bounded reload attempts after a renderer crash
    const seedUrl = resume?.seedUrl ?? loc.url;
    const startedAt = Date.now(); // start of THIS segment, not of the run
    // Active run time from previous segments. `startedAt` alone can't carry the
    // budget across an eviction: restoring it verbatim would charge the whole gap
    // to maxDurationMin, so a 20-min gap on a 10-min budget would report
    // limit-reached on the resumed run's first check.
    const priorElapsedMs = resume?.elapsedMs ?? 0;
    // Come back paused if that's how the user left it — pause is also the most
    // likely way to get evicted at all (waitWhilePaused makes no chrome.* call,
    // so it never resets MV3's idle timer).
    if (resume?.paused) this.pause();

    if (!resume) {
      await resetCrawlShots(); // FR-EX-055 — clear any shots from a previous run
      await resetCrawlErrors(); // FR-EX-082 — clear any errors from a previous run
    }

    // buffered error log → /ext/logs (FR-EX-084)
    const logBuffer: SessionLogInput[] = resume ? deserializeLogBuffer(resume.logBuffer) : [];
    // Frontier + expansion cursor. Hoisted here (rather than beside the seed
    // capture) so snapshot() can see them. `current` is the state shifted off the
    // queue but not yet fully expanded — unshifted back on resume so a
    // mid-expansion eviction doesn't drop it on the floor.
    const queue: QueuedState[] = resume ? [...resume.queue] : [];
    if (resume?.current) queue.unshift(resume.current);
    let current: QueuedState | null = null;
    // Not checkpointed: a resume always wants `false` (the tab is wherever the
    // last click left it, so the head of the frontier must be restored, never
    // assumed to be on screen), which `!resume` already says.
    let firstDequeue = !resume;
    const spawned = new Set<number>(resume?.spawned ?? []); // tabs this crawl opened (FR-EX-071)

    const sessionNonce = await getSessionNonce();

    let lastProgress: CrawlProgress = resume?.progress ?? {
      screens: captureCount,
      states: visitedStates.size,
      depth: currentDepth,
      queue: queue.length,
      pages: pages.size,
      errors,
      currentUrl,
      phase: "start",
      unreachableRegions,
    };

    // Liveness, not a budget. Every state transition emits, so a run that has not
    // emitted in STALL_TIMEOUT_MS is wedged on an await nobody anticipated. With
    // maxDurationMin gone this is the only backstop left that survives a hang the
    // cancel-racing wrappers don't cover — so it is deliberately NOT configurable
    // and deliberately generous: a slow full-page stitch on a huge page is minutes,
    // never ten. Paused time doesn't count (see the timer).
    let lastEmitAt = Date.now();
    const emit = (phase: string, queueLen: number) => {
      lastEmitAt = Date.now();
      lastProgress = {
        screens: captureCount,
        states: visitedStates.size,
        depth: currentDepth,
        queue: queueLen,
        pages: pages.size,
        errors,
        currentUrl,
        phase,
        unreachableRegions,
      };
      onProgress(lastProgress);
      checkpoint(); // FR-EX-080 — every transition that emits also persists
    };

    /** Run time excluding paused AND evicted stretches — the crawl wasn't
     *  working during either, so neither is charged to maxDurationMin. */
    const activeElapsedMs = (): number => priorElapsedMs + (Date.now() - startedAt) - this.pausedMs();

    const overLimit = (): boolean =>
      limitReason({
        shots: captureCount,
        maxScreens,
        elapsedMs: activeElapsedMs(),
        maxDurationMs,
      }) !== null;

    // ── Checkpointing (FR-EX-080) ────────────────────────────────────────────
    let ckptSeq = resume?.seq ?? 0;
    // emit() is synchronous, so its write is fire-and-forget — chain the writes
    // so a slow one can never land after (and clobber) a newer one.
    let ckptChain: Promise<unknown> = Promise.resolve();
    // Latched by the finally. Without it, a write still queued on the chain lands
    // *after* clearCheckpoint() and quietly recreates the checkpoint of a run
    // that has already finished — which the resume alarm would then dutifully
    // bring back to life and start clicking the tab again.
    let ckptClosed = false;
    /** Latched once the checkpoint can no longer be written — see `checkpoint`. */
    let checkpointDegraded = false;

    const snapshot = (): CrawlCheckpoint => ({
      v: CHECKPOINT_VERSION,
      seq: ++ckptSeq,
      at: Date.now(),
      sessionNonce,
      opts,
      scope,
      seedUrl,
      // `queue.length`, never emit()'s queueLen param — emit("uploads-suspended")
      // passes a hardcoded 0.
      queue: [...queue],
      current,
      visitedStates: [...visitedStates],
      triedPairs: [...triedPairs],
      clicksByKey: [...clicksByKey],
      pages: [...pages],
      errors,
      edges,
      deadEdges,
      abandoned,
      unreachableRegions,
      uploaded,
      duplicatesSkipped,
      maxDepthReached,
      currentDepth,
      currentUrl,
      elapsedMs: activeElapsedMs(),
      paused: this.isPaused,
      sessionId,
      uploadsSuspended,
      edgeBuffer: [...edgeBuffer],
      logBuffer: serializeLogBuffer(logBuffer),
      spawned: [...spawned],
      crashRecoveries,
      progress: lastProgress,
    });

    /** Persist the run. The snapshot is taken synchronously (single-threaded, so
     *  its contents are always self-consistent); only the write is deferred. */
    const checkpoint = (): void => {
      if (ckptClosed) return;
      const snap = snapshot();
      ckptChain = ckptChain
        .then(() => writeCheckpoint(snap))
        .then((ok) => {
          // A failed session write leaves the PREVIOUS checkpoint in place, so a
          // later eviction resumes from a stale frontier and re-clicks buttons
          // already clicked. Surface it once — a run that can no longer checkpoint
          // is no longer safely resumable, and the user needs to know that while
          // it is still running, not after.
          if (ok || checkpointDegraded) return;
          checkpointDegraded = true;
          void appendLog("error", "checkpoint-failed", {
            states: visitedStates.size,
            reason: "storage quota or no extension context — run is no longer resumable",
          });
        })
        .catch(() => {});
    };

    /** Checkpoint and wait for it to land. Used as a write-ahead barrier before
     *  an irreversible act — see the click site. */
    const checkpointNow = async (): Promise<void> => {
      checkpoint();
      await ckptChain;
    };

    const currentStats = (): Partial<SessionStats> => ({
      screensCaptured: captureCount,
      edgesRecorded: edges,
      duplicatesSkipped,
      errorsCount: errors,
      maxDepthReached,
      currentUrl,
    });

    const flushEdges = async (): Promise<void> => {
      // Unpaired ⇒ nothing to upload, and the buffer must still be DROPPED — it is
      // never read locally. Returning without clearing leaked one entry per edge
      // for the whole run, and since snapshot() deep-copies edgeBuffer on every
      // state transition it capped an unpaired run at ~770 states via the storage
      // quota. flushLogs below has always cleared correctly; this matched it.
      if (!sessionId) {
        edgeBuffer.length = 0;
        return;
      }
      while (edgeBuffer.length > 0) {
        const batch = edgeBuffer.splice(0, 100);
        try {
          await uploadEdges(sessionId, batch);
        } catch {
          /* edges are best-effort */
        }
      }
    };

    const LOG_FLUSH_AT = 25; // upload the error log once this many lines buffer
    const flushLogs = async (): Promise<void> => {
      // Unpaired ⇒ nothing to upload; the local sink still backs "View errors".
      if (!sessionId) {
        logBuffer.length = 0;
        return;
      }
      while (logBuffer.length > 0) {
        const batch = logBuffer.splice(0, 100);
        try {
          await uploadLogs(sessionId, batch);
        } catch {
          /* logs are best-effort — the local sink is the fallback */
        }
      }
    };

    // FR-EX-082 — append one log line: persist to the local sink (popup "View
    // errors", survives SW eviction / popup close) AND buffer it for the batched
    // panel upload (FR-EX-084). Best-effort; never throws, never blocks the crawl.
    const appendLog = async (
      level: "error" | "warn" | "info",
      event: string,
      context?: Record<string, unknown>,
    ): Promise<void> => {
      const at = Date.now();
      await putCrawlError({ level, event, context, at });
      logBuffer.push({ level, event, context, at: new Date(at) });
      if (logBuffer.length >= LOG_FLUSH_AT) await flushLogs();
    };

    // FR-EX-026/034 — record WHY an element was passed over, so a run that clicks
    // very little is diagnosable instead of just looking like a small app. These
    // are routine decisions, not failures: they go through appendLog at "info",
    // never recordError, which would bump the errors counter and misreport a
    // deliberate skip as something going wrong.
    //
    // The dedupe is essential, not tidiness: the expand loop re-runs discovery
    // once per element, so an undeduped log would emit a line per skipped element
    // per click cycle — quadratic in a state's element count, and enough to swamp
    // the upload buffer on a page with a big excluded region. Keyed by the same
    // (state, element) pair the engine already uses. In memory only: a resumed run
    // re-logging one line per state is cheaper than carrying this in every checkpoint.
    const skipLogged = new Set<string>();
    const unreachableLogged = new Set<string>(); // FR-EX-023 — one region log per state
    const logSkips = async (stateFp: string, candidates: InjectedCandidate[]): Promise<void> => {
      for (const c of candidates) {
        const submitSkipped = c.submit && (!opts.clickSubmitEmptyForms || c.destructive);
        const blocked = opts.safeMode && c.destructive; // FR-EX-070 — the safety skip
        // Exclude, blocked and submit are safety skips; similar is a coverage skip.
        // Report whichever applies, safety before coverage, so a skip is never
        // mislabelled as a mere look-alike when a rule actually blocked it.
        const event = c.excluded
          ? "skipped-excluded"
          : blocked
            ? "skipped-blocked" // FR-EX-070/084 — destructive, skipped in Safe mode
            : submitSkipped
              ? "skipped-submit"
              : c.nativeDialog
                ? "skipped-file" // FR-EX-075/084 — native dialog trigger, never clicked
                : c.similar
                  ? "skipped-similar"
                  : null;
        if (!event) continue;
        const k = pairKey(stateFp, c.key);
        if (skipLogged.has(k)) continue;
        skipLogged.add(k);
        await appendLog("info", event, {
          url: currentUrl,
          selector: c.selector,
          text: c.text,
          ...(event === "skipped-submit" ? { destructive: c.destructive } : {}),
        });
      }
    };

    /**
     * FR-EX-084 — the engine is giving up on part of the site. SAY SO.
     *
     * `scope: "state"` is the expensive one: the state couldn't be restored, so it
     * and everything reachable only through it are dropped — an entire subtree,
     * gone. `scope: "expansion"` drops only this state's remaining untried
     * elements. Either way the run still ends "completed", which is how a crawl
     * that covered a fraction of a site reads as a small site.
     *
     * Deliberately "warn", not recordError: giving up isn't a failure of the
     * engine, it's a limit of restoration (FR-EX-061), and bumping `errors` would
     * conflate the two. But it is never silent again.
     */
    const abandon = async (
      s: QueuedState,
      scope: "state" | "expansion",
      reason: string,
    ): Promise<void> => {
      abandoned++;
      await appendLog("warn", "abandoned", {
        scope,
        reason,
        url: s.url,
        depth: s.depth,
        fp: s.fp.slice(0, 12),
        replayPath: s.path.length, // a long path is the usual reason restore diverges
      });
    };

    // Record a swallowed failure (FR-EX-082): bump the errors counter and log it
    // with the current URL for context, so the count and the "why" stay in sync.
    const recordError = async (event: string, context?: Record<string, unknown>): Promise<void> => {
      errors++;
      await appendLog("error", event, { url: currentUrl, ...(context ?? {}) });
    };

    const mapReason = (r: CrawlReason): { status: SessionStatus; endReason: SessionEndReason } => {
      if (r === "completed") return { status: "completed", endReason: "frontier-exhausted" };
      if (r === "limit-reached") return { status: "completed", endReason: "limit-reached" };
      if (r === "cancelled") return { status: "cancelled", endReason: "cancelled" };
      return { status: "failed", endReason: "error" };
    };

    // FR-EX-040 — fingerprint the current UI state (+ title/viewport for FR-EX-054).
    const fingerprintNow = async (): Promise<{
      fp: string;
      url: string;
      origin: string;
      title: string;
      viewport: { width: number; height: number };
      dialogs: number;
    } | null> => {
      let sig;
      try {
        sig = await exec(tabId, extractStateSignature);
      } catch {
        sig = undefined;
      }
      if (!sig) return null;
      try {
        return {
          fp: await computeFingerprint(sig.url, sig.signature),
          url: sig.url,
          origin: sig.origin,
          title: sig.title,
          viewport: sig.viewport,
          dialogs: sig.dialogs ?? 0, // FR-EX-062
        };
      } catch {
        return null;
      }
    };

    // FR-EX-050/053/054/055 — mask → capture → unmask → persist (bounded memory)
    // → upload when a session is active (best-effort; ZIP fallback always kept).
    const captureState = async (
      fp: string,
      page: { url: string; title: string; viewport: { width: number; height: number } },
      depth: number,
      parentFp: string | null,
      trigger: ElementDescriptor | null,
    ): Promise<void> => {
      if (this._cancelled) return; // FR-EX-012 — Stop must not start a new capture

      // FR-EX-033 — freeze animations/transitions, pause media, and wait for
      // visible images before the shot, so the same state photographs the same
      // way every visit. Runs BEFORE masks so no mid-fade or half-loaded image
      // reaches the capture; best-effort, so a page that refuses the inline
      // <style> (strict CSP) still gets captured.
      try {
        await exec(tabId, freezeForCapture, {
          timeoutMs: IMAGE_WAIT_MS,
          settleMs: opts.captureSettleMs ?? 0,
        });
      } catch {
        /* best effort — a steadier shot is the goal, not a gate on capturing */
      }

      // C-01 — same-window crawl: captureVisibleTab only sees the focused
      // window's active tab, so if the user switched tabs we re-activate ours
      // before the shot. We don't force-refocus the window on every capture
      // (that would yank focus from other apps); the window is focused once at
      // Start and the "don't switch tabs" badge covers the rest. A transient
      // focus loss just fails the shot and EC-013 retries below.
      try {
        await chrome.tabs.update(tabId, { active: true });
      } catch {
        /* tab may be gone (EC-019) — the capture below fails and is handled */
      }

      // One viewport shot: space out per C-01, mask (FR-EX-053) + hide the badge,
      // grab it, restore. Returns "" and a message on failure. Shared by the
      // single-shot path and every segment of the full-page path.
      let captureError = "";
      const takeViewportShot = async (): Promise<string | undefined> => {
        const gap = CAPTURE_SPACING_MS - (Date.now() - lastCaptureAt);
        if (gap > 0) await sleep(gap);
        try {
          await exec(tabId, applyMasks, { selectors: opts.maskSelectors ?? [] });
          await exec(tabId, setRunBadgeVisible, { visible: false });
        } catch {
          /* best effort */
        }
        let shot: string | undefined;
        try {
          // FR-EX-090 — under device emulation captureVisibleTab is WRONG: it
          // copies the real window surface, so it would return a desktop-sized
          // PNG with the phone viewport letterboxed inside it. The debugger is
          // already attached for the whole run in mobile mode, so the CDP shot
          // costs nothing extra here.
          shot = mobileEmulated
            ? await cdpViewportShot()
            : await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
        } catch (e) {
          captureError = e instanceof Error ? e.message : String(e);
          // Only rate/focus failures are worth a retry. A missing permission is
          // not transient — retrying burns CAPTURE_SPACING_MS on every state and
          // buries the one error that explains all of them.
          if (isCaptureDenied(captureError)) {
            shot = undefined;
          } else {
            await sleep(CAPTURE_SPACING_MS + 100); // EC-013 backoff
            try {
              shot = mobileEmulated
                ? await cdpViewportShot()
                : await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
              captureError = "";
            } catch (e2) {
              captureError = e2 instanceof Error ? e2.message : String(e2);
            }
          }
        } finally {
          try {
            await exec(tabId, removeMasks);
            await exec(tabId, setRunBadgeVisible, { visible: true });
          } catch {
            /* best effort */
          }
        }
        lastCaptureAt = Date.now();
        return shot;
      };

      // FR-EX-051 — full-page scroll-and-stitch: walk the page a viewport at a
      // time (≤ MAX_FULLPAGE_SEGMENTS, EC-007), hiding fixed/sticky chrome on the
      // intermediate segments so a sticky header isn't stamped into each slice,
      // and stitch the shots into one tall PNG. Any failure falls back to the
      // single viewport already on screen — full-page is a nicety, not a gate.
      const fullPageShot = async (): Promise<string | undefined> => {
        const first = await exec(tabId, scrollToY, { y: 0 });
        if (!first || first.scrollHeight <= first.innerHeight + 4) {
          return takeViewportShot(); // not scrollable — one viewport is the whole page
        }
        const wanted = Math.ceil(first.scrollHeight / first.innerHeight);
        const count = Math.min(wanted, MAX_FULLPAGE_SEGMENTS);
        if (wanted > count) {
          await appendLog("info", "fullpage-truncated", {
            url: page.url,
            capturedSegments: count,
            neededSegments: wanted,
            reason: `page taller than ${MAX_FULLPAGE_SEGMENTS} viewports — captured the top (EC-007)`,
          });
        }
        const segments: { dataUrl: string; y: number }[] = [];
        for (let i = 0; i < count; i++) {
          if (this._cancelled) break; // FR-EX-012
          const m = await exec(tabId, scrollToY, { y: i * first.innerHeight });
          if (!m) break;
          if (i > 0) await exec(tabId, setFixedHidden, { hide: true }); // FR-EX-051
          const shot = await takeViewportShot();
          if (i > 0) await exec(tabId, setFixedHidden, { hide: false });
          if (!shot) {
            if (i === 0) return undefined; // top failed → treat as a failed capture
            break; // a later segment failed → stitch what we have
          }
          segments.push({ dataUrl: shot, y: m.scrollY }); // m.scrollY is the CLAMPED offset
        }
        await exec(tabId, scrollToY, { y: 0 }); // leave the page where we found it
        const stitched = await stitchSegments(segments, first.innerWidth);
        return stitched ?? segments[0]?.dataUrl; // if the canvas failed, the top shot still stands
      };

      // FR-EX-052 — pro capture: one pixel-perfect full-page shot via CDP
      // (Page.captureScreenshot + captureBeyondViewport). Returns undefined to
      // signal "fall back to scroll-and-stitch" — a pro-mode failure must never
      // abort the capture. Two ways it bows out: the debugger can't attach (the
      // user has DevTools open, or declines), or PII masking is configured — a
      // single beyondViewport shot can't mask below-fold content (fixed overlays
      // only cover the viewport), so masking falls back to the per-segment path
      // that masks each segment correctly (FR-EX-053 must hold even in pro mode).
      const cdpFullPageShot = async (): Promise<string | undefined> => {
        if ((opts.maskSelectors?.length ?? 0) > 0) return undefined; // can't mask below-fold in one shot
        // FR-EX-012 — none of the chrome.debugger calls below are covered by
        // raceCancel, and attaching after a Stop would raise the debugger banner
        // on a run that is already over. Falling back to undefined is safe: the
        // caller treats it as "use scroll-and-stitch", and that path is raced.
        if (this._cancelled) return undefined;
        const gap = CAPTURE_SPACING_MS - (Date.now() - lastCaptureAt); // C-01 / FR-EX-050 spacing
        if (gap > 0) await sleep(gap);
        if (this._cancelled) return undefined; // the spacing sleep may have raced a Stop
        const target: chrome.debugger.Debuggee = { tabId };
        let attached = false;
        try {
          try {
            const ok = await withTimeout(
              chrome.debugger.attach(target, "1.3"),
              CDP_TIMEOUT_MS,
            ).then(
              () => true,
              () => false,
            );
            if (!ok) return undefined; // same hang risk as the mobile pass
            attached = true;
          } catch {
            return undefined; // already attached (DevTools) or user declined → fall back
          }
          try {
            await withTimeout(chrome.debugger.sendCommand(target, "Page.enable"), CDP_TIMEOUT_MS);
          } catch {
            /* Page.enable is best-effort — captureScreenshot works without it */
          }
          await exec(tabId, setRunBadgeVisible, { visible: false }); // keep the badge out of the shot
          let data: string | undefined;
          try {
            const res = (await withTimeout(
              chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
                format: "png",
                captureBeyondViewport: true,
                fromSurface: true,
              }),
              CDP_TIMEOUT_MS,
            )) as { data?: string } | undefined;
            data = res?.data;
          } finally {
            try {
              await exec(tabId, setRunBadgeVisible, { visible: true });
            } catch {
              /* best effort */
            }
          }
          lastCaptureAt = Date.now();
          return data ? `data:image/png;base64,${data}` : undefined;
        } catch {
          return undefined; // any CDP error → fall back to scroll-and-stitch
        } finally {
          // ALWAYS detach, or Chrome's debugging banner (and the attach) leaks
          // past this capture and blocks the next one / the user's own DevTools.
          if (attached) {
            try {
              await withTimeout(chrome.debugger.detach(target), CDP_TIMEOUT_MS);
            } catch {
              /* already gone */
            }
          }
        }
      };

      // FR-EX-052 — pro mode is itself a full-page mode; on any failure it falls
      // back to scroll-and-stitch (FR-EX-051), never to a bare viewport shot. Log
      // which path ran so a run makes clear whether the pixel-perfect CDP shot or
      // the stitch fallback produced the image.
      let dataUrl: string | undefined;
      if (opts.proCaptureMode) {
        const cdp = await cdpFullPageShot();
        dataUrl = cdp ?? (await fullPageShot());
        await appendLog("info", "pro-capture", { url: page.url, method: cdp ? "cdp" : "fallback" });
      } else if (opts.fullPage) {
        dataUrl = await fullPageShot();
      } else {
        dataUrl = await takeViewportShot();
      }
      if (!dataUrl) {
        // FR-EX-050/EC-013. Report what Chrome actually said: this used to assert
        // "the window may have lost focus", which sent a real investigation down
        // the wrong path for hours — the true cause was a missing permission, and
        // Chrome had said so plainly.
        await recordError("capture-failed", {
          message: isCaptureDenied(captureError)
            ? "Chrome refused the screenshot: SnapCrawl doesn't have permission to capture this tab. Reopen the popup and grant access when asked, then start again."
            : captureError
              ? `Screenshot failed: ${captureError}`
              : "Screenshot capture returned no image (the window may have lost focus — C-01).",
          chromeError: captureError || null,
          title: page.title,
        });
        return;
      }

      await putCrawlShot(captureCount, dataUrl); // FR-EX-055 — offload immediately
      captureCount++;

      const meta: CaptureMeta = {
        url: page.url,
        title: page.title,
        depth,
        parentFingerprint: parentFp,
        triggerElement: trigger,
        // Under emulation the page reports the EMULATED size, so page.viewport is
        // already the phone's — recorded as measured either way.
        viewport: page.viewport,
        fullPage: opts.fullPage,
        clientTimestamp: new Date(),
        // FR-EX-090 — the whole run is one device, so every screen in it carries
        // that run's variant. No per-screen ambiguity, no salted fingerprints:
        // each run is its own session, so a desktop and a mobile crawl of the
        // same site can't collide on (sessionId, fingerprint) in the first place.
        variant: wantMobile ? "mobile" : "desktop",
      };

      // FR-EX-081 — upload via the SW. Offline queue full ⇒ suspend uploads
      // (captures still land in storage, so the ZIP fallback stays intact).
      if (sessionId && !uploadsSuspended) {
        // Raced like every other await in the loop: uploadCapture fans out to
        // presign + PUT + complete, each retried up to 3×, and none of that is
        // covered by raceCancel on its own. `undefined` (cancelled) is treated as
        // a miss — the capture is already in the local sink, so the ZIP is intact.
        const r = await raceCancel(
          uploadCapture({
            sessionId,
            stateFingerprint: fp,
            contentType: "image/png",
            dataUrl,
            meta,
          }),
        );
        if (!r) {
          /* cancelled mid-upload — the shot is on disk; nothing else to do */
        } else if (r.ok) {
          if (r.duplicate) duplicatesSkipped++;
          else uploaded++;
        } else if (r.full) {
          uploadsSuspended = true;
          emit("uploads-suspended", 0);
        }
      }
    };

    const installNet = async (): Promise<void> => {
      try {
        await execMain(tabId, installNetworkCounter, { allowedDomains: scope });
      } catch {
        /* http page without patchable fetch, or injection blocked — best effort */
      }
    };

    // FR-EX-073 — neutralise native dialogs in ALL same-origin frames, as early
    // as executeScript allows. Called eagerly on every navigation (webNavigation
    // onCommitted) + at seed + after each click so a page's confirm()/alert()
    // can't stall the loop. Combined with the exec timeout, a dialog can never
    // hang the crawl.
    const injectDialogGuards = async (): Promise<void> => {
      try {
        await execMain(tabId, neutralizeDialogsInPage, undefined, true /* allFrames */);
      } catch {
        /* best effort */
      }
    };
    // FR-EX-060 — track navigations the engine DIDN'T initiate. A crawl click
    // goes through settleAfterClick, which re-installs the page-side scripts and
    // re-fingerprints; but a page can move itself with no click at all — a
    // <meta http-equiv=refresh>, an on-load location.href=, a header/JS redirect.
    // Those wipe the MAIN-world network counter and can bounce the tab off-scope,
    // and nothing was watching for them.
    let outOfBandNavs = 0;
    const MAX_OFF_SCOPE_PULLBACKS = 30; // a page that redirects off-scope forever ⇒ give up, don't spin
    // FR-EX-076 — the auth URL we last auto-paused on, so we notify once per
    // landing rather than on every commit while parked there.
    let authPausedFor: string | null = null;
    // FR-EX-076 — tell the user to re-authenticate. Best-effort: the permission
    // may be absent, or notifications suppressed; the auto-pause stands regardless.
    const notifyAuthPause = (url: string): void => {
      try {
        chrome.notifications?.create?.(`sc-auth-${Date.now()}`, {
          type: "basic",
          iconUrl: chrome.runtime.getURL("assets/icon-128.png"),
          title: "SnapCrawl paused — sign-in needed",
          message: `The crawl reached a login/logout page (${url}). Log back in in the crawl window, then Resume.`,
          priority: 2,
        });
      } catch {
        /* notifications unavailable — the paused state + session log still surface it */
      }
    };
    const onCommitted = (d: { tabId: number; frameId?: number; url?: string }): void => {
      if (d.tabId !== tabId) return;
      // Dialogs must die in every frame, main or sub (FR-EX-073) — before the
      // main-frame gate below, which the rest of this handler needs.
      void injectDialogGuards();
      if (d.frameId !== undefined && d.frameId !== 0) return; // only the main frame moves the crawl
      const url = d.url;

      // FR-EX-071 — enforce allowedDomains on EVERY navigation, not just clicks
      // and window.open. The engine never navigates off-scope itself (navTo and
      // clickCandidate both check first), so an off-scope main-frame commit is by
      // definition out-of-band. Pull the tab back to the state we're on —
      // loop-safe because currentUrl is the state's own page, never the
      // redirector that just fired — and log it so the bounce is visible.
      if (url && !isInScope(url, scope)) {
        outOfBandNavs++;
        if (outOfBandNavs <= MAX_OFF_SCOPE_PULLBACKS) {
          void appendLog("warn", "out-of-scope-nav", { url, returnedTo: currentUrl });
          void chrome.tabs.update(tabId, { url: currentUrl }).catch(() => {});
        } else if (outOfBandNavs === MAX_OFF_SCOPE_PULLBACKS + 1) {
          // A page stuck in an off-scope redirect loop: stop fighting it and
          // finalise (FR-EX-071 keeps us OUT; the crawl can't proceed here).
          void appendLog("error", "off-scope-redirect-loop", { url });
          this.cancel("self:off-scope"); // NOT a user Stop — keep them tellable apart
        }
        return;
      }

      // FR-EX-060 — a full navigation wipes the MAIN-world network counter, so
      // re-inject it on every main-frame commit (idempotent). Without this, a
      // page reached by an out-of-band redirect settles on DOM-quiet alone, blind
      // to its in-flight XHR/fetch. Cheap: main-frame commits are rare.
      if (url) void installNet();

      // FR-EX-076 / EC-002 — the crawl landed on a login/logout page (it got
      // logged out, or clicked its way to one). Auto-pause and ask the user to
      // re-authenticate, ONCE per landing: clicking further would just crawl the
      // auth wall and, worse, could submit credentials-shaped forms. Resume is the
      // user's call after they log back in.
      const authHit = url ? matchesAuthUrl(url, opts.loginUrlPatterns) : null;
      if (authHit && !this.isPaused && !authPausedFor) {
        authPausedFor = url!;
        this.pause();
        emit("auth-paused", queue.length);
        void appendLog("warn", "auth-paused", { url, matched: authHit });
        notifyAuthPause(url!);
      } else if (!authHit) {
        authPausedFor = null; // moved off the auth page — a fresh landing can pause again
      }
    };

    // FR-EX-073 / EC-022 — the authoritative dialog suppressor. Register the
    // MAIN-world guard (public/dialog-guard.js) at document_start for the crawl
    // scope so it runs BEFORE any page script and the page can never arm a
    // beforeunload "Leave site?" prompt (which would block the crawl's own
    // navigations). executeScript at document_idle is too late for a handler the
    // page registered at load, since window beforeunload listeners fire in
    // registration order — hence a real content-script registration.
    const registerDialogGuard = async (): Promise<void> => {
      // seedUrl, not loc.url — on resume the tab may have drifted off the run's
      // origins, and the guard must still cover the origins the crawl works in.
      const matches = crawlOrigins(seedUrl, scope);
      if (matches.length === 0) return;
      try {
        await chrome.scripting.unregisterContentScripts({ ids: [DIALOG_GUARD_ID] });
      } catch {
        /* nothing registered from a previous run — fine */
      }
      try {
        await chrome.scripting.registerContentScripts([
          {
            id: DIALOG_GUARD_ID,
            js: ["dialog-guard.js"],
            matches,
            runAt: "document_start",
            world: "MAIN",
            allFrames: true,
            persistAcrossSessions: false,
          },
        ]);
      } catch {
        /* best effort — the executeScript belt (injectDialogGuards) still runs */
      }
    };
    const unregisterDialogGuard = async (): Promise<void> => {
      try {
        await chrome.scripting.unregisterContentScripts({ ids: [DIALOG_GUARD_ID] });
      } catch {
        /* ignore */
      }
    };

    // FR-EX-032 — wait for UI stability (DOM quiet + network idle) in MAIN world.
    const waitStable = async (): Promise<void> => {
      try {
        await execMain(tabId, waitForStable, {
          quietMs: STABILITY_QUIET_MS,
          timeoutMs: STABILITY_TIMEOUT_MS,
        });
      } catch {
        /* stability is best-effort */
      }
    };

    // Wait until the tab finishes loading after a navigation.
    const waitForLoad = async (): Promise<boolean> => {
      const deadline = Date.now() + NAV_READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (this._cancelled) return false;
        let status: string | undefined;
        try {
          status = (await chrome.tabs.get(tabId)).status;
        } catch {
          status = undefined;
        }
        if (status === "complete") return true;
        await sleep(150);
      }
      return false;
    };

    // FR-EX-032 — settle after a click that may or may not navigate: let a full
    // navigation commit, wait it out, RE-INSTALL the MAIN-world network counter
    // (a page load wipes it; installNet is idempotent so it's a no-op otherwise),
    // wait for DOM + network idle, then apply clickDelayMs.
    const settleAfterClick = async (): Promise<void> => {
      await sleep(NAV_NUDGE_MS);
      await injectDialogGuards(); // before waiting, so a load-time dialog can't stall us
      await waitForLoad();
      await installNet();
      await injectDialogGuards(); // and again once frames exist
      try {
        await exec(tabId, applyRunBadge); // FR-EX-011 — re-show the badge after a nav
      } catch {
        /* best effort */
      }
      await waitStable();
      await sleep(clickDelayMs);
    };

    // FR-EX-083 / EC-019 — a crashed renderer ("Aw, Snap!" / STATUS_BREAKPOINT)
    // leaves the tab PRESENT but its main frame unscriptable, so every injection
    // returns undefined — unlike a *closed* tab, which onTabRemoved catches. Probe
    // liveness; if the tab crashed, reload it to respawn the renderer (bounded, so
    // a repeatedly-crashing page can't loop), after which the BFS re-establishes
    // state by navigation (FR-EX-061). Sets `tabCrashed` when the tab crashed and
    // couldn't be revived. Returns true iff the tab is scriptable now.
    const MAX_CRASH_RECOVERIES = 2;
    const ensureTabAlive = async (): Promise<boolean> => {
      // Fast path: a scriptable main frame means there was no crash.
      if ((await exec(tabId, getLocation)) !== undefined) return true;
      // Unscriptable — is the tab merely gone (closed), or crashed?
      try {
        await chrome.tabs.get(tabId);
      } catch {
        return false; // closed — onTabRemoved (EC-019) owns finalisation
      }
      if (crashRecoveries >= MAX_CRASH_RECOVERIES) {
        tabCrashed = true;
        return false;
      }
      crashRecoveries++;
      try {
        await chrome.tabs.reload(tabId); // respawn the renderer
        await waitForLoad();
        await injectDialogGuards();
        await installNet();
      } catch {
        /* reload failed — fall through to the re-probe below */
      }
      if ((await exec(tabId, getLocation)) !== undefined) return true; // revived
      tabCrashed = true;
      return false;
    };

    /** Navigate the crawl tab and let the page settle. false ⇒ couldn't. */
    const navTo = async (url: string): Promise<boolean> => {
      if (!isInScope(url, scope)) return false; // FR-EX-010/071
      try {
        await chrome.tabs.update(tabId, { url });
      } catch {
        return false;
      }
      await sleep(300); // let the navigation actually start
      await waitForLoad();
      await installNet();
      await waitStable();
      return !this._cancelled;
    };

    /**
     * FR-EX-061 — get back to a state, in three escalating stages:
     *
     *   1. direct navigation to s.url + verify the fingerprint  (cheap, usual case)
     *   2. navigate to s.replayFrom and replay s.path + verify  (the fallback)
     *   3. abandon
     *
     * Stage 2 is the whole point. It used to not exist: a child whose URL differed
     * from its parent's was assumed route-addressable and stored with an EMPTY
     * path, so when stage 1 failed there was nothing to fall back to and the state
     * — plus everything reachable only through it — was dropped. On a real Next.js
     * app that was four of five abandoned branches.
     */
    const MAX_REPLAY = 10; // FR-EX-061 caps the replay path
    const restore = async (s: QueuedState): Promise<boolean> => {
      // ── stage 1: direct navigation ──
      if (await navTo(s.url)) {
        const direct = await fingerprintNow();
        if (direct && isInScope(direct.url, scope)) {
          if (direct.fp === s.fp) {
            currentUrl = direct.url;
            pages.add(direct.url);
            return true;
          }
          // The fingerprint drifted, but this state has NO replay path — it is
          // defined by its URL and nothing else, so landing on that URL in scope
          // IS the restore. Demanding an exact DOM match here made the crawler
          // useless on ordinary sites: the signature counts only VISIBLE nodes,
          // so a rotating carousel, a lazy-loaded image or a scroll animation
          // changes it between two visits to the same page. The seed state is
          // always path-less, so the very first "go back and keep expanding"
          // failed and the whole site after the first click went unexplored —
          // the run then reported "completed — explored every reachable state",
          // which was a flat lie. Drift is logged, never silent.
          if (s.path.length === 0 && normalizeUrl(direct.url) === normalizeUrl(s.url)) {
            currentUrl = direct.url;
            pages.add(direct.url);
            await appendLog("info", "restored-with-drift", {
              url: s.url,
              depth: s.depth,
              reason:
                "page re-rendered differently (carousel, lazy image or animation) but it is the same URL-defined state",
            });
            return true;
          }
        }
      }
      if (this._cancelled) return false;

      // ── stage 2: replay the click path from its anchor ──
      // Nothing to replay, or too long to trust (FR-EX-061) ⇒ stage 3.
      if (s.path.length === 0 || s.path.length > MAX_REPLAY) return false;
      // Stage 1 already navigated; only move again if we're not on the anchor.
      const at = await exec(tabId, getLocation);
      if (!at || normalizeUrl(at.url) !== normalizeUrl(s.replayFrom)) {
        if (!(await navTo(s.replayFrom))) return false;
      }
      if (this._cancelled) return false;

      for (const step of s.path) {
        if (this._cancelled) return false;
        let disc: DiscoverResult | undefined;
        try {
          disc = await exec(tabId, discoverCandidates, {
            blocklist: opts.blocklist,
            excludeSelectors: opts.excludeSelectors ?? [], // FR-EX-026
            excludeUrlPatterns: opts.excludeUrlPatterns ?? [],
            siblingCollapseLimit: opts.siblingCollapseLimit ?? 2, // FR-EX-025
          });
        } catch {
          disc = undefined;
        }
        if (!disc) return false;
        const cand = matchCandidate(disc.candidates, step);
        if (!cand) return false; // divergence → abandon
        if (opts.safeMode && cand.destructive) return false; // FR-EX-070 — never replay-click destructive
        // The same gates as pickNextForState. A path recorded BEFORE a rule was
        // configured (or before this landed) would otherwise still replay-click
        // the element — the rule has to hold on restore/resume too, not just on
        // first discovery.
        if (cand.excluded) return false; // FR-EX-026
        if (cand.submit && (!opts.clickSubmitEmptyForms || cand.destructive)) return false; // FR-EX-034
        if (cand.nativeDialog) return false; // FR-EX-075
        let clicked: { ok: boolean } | undefined;
        try {
          clicked = await exec(tabId, clickCandidate, {
            idx: cand.idx,
            allowedDomains: scope,
            // FR-EX-035 — refill on replay too, so a submit re-reaches its
            // post-submit state instead of a validation wall.
            fillForm: !!opts.formFillDummyData && cand.submit,
            maskSelectors: opts.maskSelectors ?? [],
          });
        } catch {
          clicked = { ok: false };
        }
        if (!clicked?.ok) return false;
        await settleAfterClick();
        // Post-click scope guard (FR-EX-010/071) — abandon if replay left scope.
        const here = await exec(tabId, getLocation);
        if (here && !isInScope(here.url, scope)) return false;
      }

      const fp = await fingerprintNow();
      if (!fp) return false;
      if (!isInScope(fp.url, scope)) return false; // ended off-scope → abandon
      if (s.fp && fp.fp !== s.fp) return false; // verification failed
      currentUrl = fp.url;
      pages.add(fp.url);
      return true;
    };

    const childState = (
      parent: QueuedState,
      after: { fp: string; url: string },
      step: InjectedCandidate,
    ): QueuedState => {
      const desc: ClickStep = {
        key: step.key,
        tag: step.tag,
        role: step.role,
        text: step.text,
        href: step.href,
        anchor: step.anchor, // FR-EX-024 — the strongest re-find signal
        selector: step.selector,
        containerKey: step.containerKey, // FR-EX-061 — the row, so replay survives a reorder
      };
      // ALWAYS retain the path. This used to throw it away whenever the URL
      // changed — "the route changed, so navigation will bring us back" — which is
      // an assumption, not a fact. A client-side route, a query-string variant, or
      // any state that only exists after an interaction all change the URL while
      // being unreachable by a fresh load of it. When that assumption was wrong
      // there was no fallback, so restore() failed and the state plus its whole
      // subtree went silently. Measured on a real Next.js app: 4 of 5 abandoned
      // branches, every one of them `replayPath: 0` — states this line had
      // declared route-addressable.
      //
      // The path costs a few bytes per state; being wrong costs a subtree. Direct
      // navigation is still tried FIRST in restore(), so the common case (a real
      // link) is unchanged and pays nothing.
      return {
        url: after.url, // where it actually ended up — the direct-nav candidate
        // A changed route makes THIS url a plausible new anchor, but only a
        // successful replay would prove it. Keep the parent's anchor: it is the
        // last place we know a replay can start from.
        replayFrom: parent.replayFrom,
        // Bounded to MAX_REPLAY + 1 so the checkpoint stops growing with depth,
        // WITHOUT changing which states are replayable. restore() rejects any
        // path longer than MAX_REPLAY, and a path that overflows stays at
        // MAX_REPLAY + 1, so it is still rejected exactly as before. Do NOT
        // slice to MAX_REPLAY: that would make an over-long path PASS the guard
        // and replay a truncated sequence from the anchor — divergent clicks on
        // a live page, which is far worse than abandoning the branch.
        path: [...parent.path, desc].slice(-(MAX_REPLAY + 1)),
        depth: parent.depth + 1,
        fp: after.fp,
      };
    };

    // FR-EX-071 — auto-close out-of-scope tabs/windows the CRAWL spawns during
    // THIS run only. We track spawned tab ids in a per-run set (never acting on
    // a tab merely because its opener is the crawl tab), so the user's own
    // pre-existing tabs are never touched — even if they were opened from the
    // crawl tab earlier. (`spawned` is declared with the rest of the run state
    // above, so it survives an eviction along with everything else.)
    const closeSpawnedIfOutOfScope = (tid: number | undefined, url: string | undefined): void => {
      if (!tid || tid === tabId || !spawned.has(tid)) return;
      if (url && !isInScope(url, scope)) {
        void chrome.tabs.remove(tid).catch(() => {});
        spawned.delete(tid);
      }
    };
    const onTabCreated = (t: chrome.tabs.Tab): void => {
      if (t.id && t.openerTabId === tabId) {
        spawned.add(t.id);
        closeSpawnedIfOutOfScope(t.id, t.pendingUrl || t.url);
      }
    };
    // Catches target=_blank / window.open including noopener (no openerTabId).
    const onNavTarget = (d: { sourceTabId: number; tabId: number; url?: string }): void => {
      if (d.sourceTabId !== tabId) return;
      spawned.add(d.tabId);
      closeSpawnedIfOutOfScope(d.tabId, d.url);
    };
    const onTabUpdated = (tid: number, info: { url?: string }, t: chrome.tabs.Tab): void =>
      closeSpawnedIfOutOfScope(tid, info.url || t.url);
    const onTabRemoved = (tid: number): void => {
      spawned.delete(tid);
      if (tid === tabId) {
        // EC-019 — the crawl tab (the user's own tab) was closed. Stop and
        // finalise as failed with whatever partial results we have (FR-EX-083).
        tabClosed = true;
        this.cancel();
      }
    };
    // FR-EX-074 / EC-005 — a click that starts a file download must be cancelled,
    // not left to pile files into the user's Downloads folder. DownloadItem has no
    // tabId, so we attribute by scope: a download whose referrer (the page that
    // triggered it) or URL is in the crawl's scope is ours. Requiring an in-scope
    // signal keeps a user's own download in another window untouched.
    const onDownloadCreated = (item: chrome.downloads.DownloadItem): void => {
      const ref = item.referrer || "";
      const src = item.finalUrl || item.url || "";
      const ours = (ref !== "" && isInScope(ref, scope)) || (src !== "" && isInScope(src, scope));
      if (!ours) return;
      void chrome.downloads.cancel(item.id).catch(() => {});
      void chrome.downloads.erase({ id: item.id }).catch(() => {}); // don't leave it in history
      void appendLog("info", "download-cancelled", {
        url: src,
        referrer: ref,
        filename: item.filename || "",
      });
    };
    const installScopeGuard = (): void => {
      try {
        chrome.tabs.onCreated.addListener(onTabCreated);
        chrome.tabs.onUpdated.addListener(onTabUpdated);
        chrome.tabs.onRemoved.addListener(onTabRemoved);
        chrome.webNavigation.onCreatedNavigationTarget.addListener(onNavTarget);
        chrome.webNavigation.onCommitted.addListener(onCommitted);
        chrome.downloads.onCreated.addListener(onDownloadCreated); // FR-EX-074
      } catch {
        /* ignore */
      }
    };
    const removeScopeGuard = (): void => {
      try {
        chrome.tabs.onCreated.removeListener(onTabCreated);
        chrome.tabs.onUpdated.removeListener(onTabUpdated);
        chrome.tabs.onRemoved.removeListener(onTabRemoved);
        chrome.webNavigation.onCreatedNavigationTarget.removeListener(onNavTarget);
        chrome.webNavigation.onCommitted.removeListener(onCommitted);
        chrome.downloads.onCreated.removeListener(onDownloadCreated); // FR-EX-074
      } catch {
        /* ignore */
      }
    };

    let reason: CrawlReason = "completed";
    let errorMessage: string | undefined;

    /** The run's result, from wherever it ends. Shared by the normal exit and the
     *  early returns below so they can never drift apart. Reads the counters at
     *  call time, so an early exit still reports the work already done. */
    const buildResult = (): CrawlResult => ({
      captures: captureCount,
      reason,
      states: visitedStates.size,
      pages: pages.size,
      edges,
      deadEdges,
      abandoned,
      uploaded,
      unreachableRegions,
      sessionId,
      ...(errorMessage ? { error: errorMessage } : {}),
    });
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let watchdogTimer: ReturnType<typeof setInterval> | undefined;

    // ── FR-EX-090: device emulation, once for the whole run ──────────────────
    //
    // Mobile is a MODE, not a second pass. The debugger attaches once here and
    // detaches once in the finally, so the phone viewport is simply what the
    // page is for the entire crawl — discovery, clicking and capture all see the
    // same layout. That is both more correct (you crawl the mobile site, with its
    // hamburger nav and mobile-only flows) and vastly simpler than emulating
    // per state: no restore-to-desktop between states, so none of the geometry
    // can get stuck half-applied.
    const wantMobile = opts.captureMode === "mobile";
    const mv = opts.mobileViewport ?? { width: 430, height: 932 };
    const dbgTarget: chrome.debugger.Debuggee = { tabId };
    let dbgAttached = false;
    let mobileEmulated = false;

    /** Viewport screenshot through CDP — the only correct one under emulation. */
    const cdpViewportShot = async (): Promise<string> => {
      const res = (await withTimeout(
        chrome.debugger.sendCommand(dbgTarget, "Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
          fromSurface: true,
        }) as Promise<unknown>,
        CDP_TIMEOUT_MS,
      )) as { data?: string } | undefined;
      // THROW, don't return undefined: takeViewportShot's catch owns the EC-013
      // retry-with-backoff, and a CDP timeout under a briefly busy renderer is
      // exactly the transient failure that retry exists for. Returning undefined
      // would skip the retry and record a failed capture on the first hiccup.
      if (!res?.data) throw new Error("CDP screenshot returned no image");
      return `data:image/png;base64,${res.data}`;
    };

    // Chrome's "SnapCrawl is debugging this browser" infobar has a CANCEL button,
    // and opening DevTools on the crawl tab steals the session too. Either one
    // detaches us mid-run. Without this listener mobileEmulated stays true, every
    // subsequent cdpViewportShot fails, and the run keeps going while capturing
    // nothing — a silent write-off of the rest of the crawl. Detected, the run
    // stops with an explanation instead.
    const onDebuggerDetach = (src: chrome.debugger.Debuggee): void => {
      if (src.tabId !== tabId || !dbgAttached) return;
      dbgAttached = false;
      mobileEmulated = false;
      void appendLog("error", "debugger-detached", {
        reason:
          "the debugger was detached mid-run (banner dismissed, or DevTools opened on this tab) — a mobile crawl cannot capture without it",
      });
      this.cancel("self:stalled");
    };
    try {
      chrome.debugger.onDetach.addListener(onDebuggerDetach);
    } catch {
      /* no debugger API in this context — mobile mode simply won't start */
    }

    /** Attach + emulate. Returns false if mobile mode can't be honoured, and the
     *  caller fails the run rather than silently capturing desktop shots and
     *  labelling them mobile. */
    const startMobileEmulation = async (): Promise<boolean> => {
      const ok = await withTimeout(chrome.debugger.attach(dbgTarget, "1.3"), CDP_TIMEOUT_MS).then(
        () => true,
        () => false,
      );
      if (!ok) return false;
      dbgAttached = true;
      const cdp = (method: string, params?: Record<string, unknown>): Promise<unknown> =>
        withTimeout(
          chrome.debugger.sendCommand(dbgTarget, method, params) as Promise<unknown>,
          CDP_TIMEOUT_MS,
        );
      await cdp("Page.enable");
      await cdp("Emulation.setDeviceMetricsOverride", {
        width: mv.width,
        height: mv.height,
        deviceScaleFactor: MOBILE_DPR,
        mobile: true,
        screenWidth: mv.width,
        screenHeight: mv.height,
        positionX: 0,
        positionY: 0,
        dontSetVisibleSize: false,
      });
      // userAgentMetadata is NOT optional: without it Sec-CH-UA-Mobile still
      // announces ?0, so a Client-Hints-sniffing site serves its desktop build.
      await cdp("Emulation.setUserAgentOverride", {
        userAgent: MOBILE_UA,
        acceptLanguage: "en-US,en",
        platform: "Linux armv8l",
        userAgentMetadata: {
          brands: [
            { brand: "Chromium", version: "127" },
            { brand: "Not)A;Brand", version: "99" },
          ],
          fullVersion: "127.0.0.0",
          platform: "Android",
          platformVersion: "13",
          architecture: "",
          model: "Pixel 7",
          mobile: true,
        },
      });
      await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      const m = await exec(tabId, settleAfterViewportChange, {
        expectWidth: mv.width,
        timeoutMs: MOBILE_SETTLE_MS,
      });
      if (!m || Math.abs(m.innerWidth - mv.width) > 20) return false;
      mobileEmulated = true;
      return true;
    };

    const stopMobileEmulation = async (): Promise<void> => {
      if (!dbgAttached) return;
      // Detaching is what actually resets emulation, so this is belt-and-braces
      // rather than load-bearing — but leaving a tab the user keeps using stuck
      // at phone width would be a nasty parting gift.
      try {
        await withTimeout(
          chrome.debugger.sendCommand(
            dbgTarget,
            "Emulation.clearDeviceMetricsOverride",
          ) as Promise<unknown>,
          CDP_TIMEOUT_MS,
        );
      } catch {
        /* detach resets it anyway */
      }
      try {
        await withTimeout(chrome.debugger.detach(dbgTarget), CDP_TIMEOUT_MS);
      } catch {
        /* already gone */
      }
      dbgAttached = false;
      mobileEmulated = false;
    };

    installScopeGuard();
    try {
      // FR-EX-073 — arm the document_start beforeunload guard for the scope, then
      // reload the seed tab so the already-open page comes back UNDER the guard.
      // The reload happens before any crawl interaction, so the current page's own
      // beforeunload can't prompt (no user gesture on it yet); we still neutralise
      // it first as a belt. After this, every page the crawl loads is guarded.
      await registerDialogGuard();
      // FR-EX-090 — emulate BEFORE the seed reload, so the page loads as a phone
      // from its very first request. That is the whole advantage of a mode over a
      // per-state pass: a site that picks its layout server-side from the
      // User-Agent, or once at bundle init, gets the mobile branch for real
      // instead of a desktop DOM squeezed narrow.
      if (wantMobile) {
        // Retry before giving up. On the RESUME path especially: the evicted
        // worker's debugger attachment may not be reaped yet ("Another debugger
        // is already attached"), and the tab may still be mid-navigation from
        // the click that was in flight when the worker died. Both are transient.
        let ok = false;
        for (let attempt = 1; attempt <= 3 && !ok && !this._cancelled; attempt++) {
          if (attempt > 1) {
            await stopMobileEmulation(); // clear a half-attached session first
            await sleep(500 * attempt);
          }
          ok = await startMobileEmulation();
        }
        if (!ok) {
          if (this._cancelled) {
            // Stop during startup — exec() resolves undefined on cancel, which
            // is indistinguishable from a genuine failure here. Reporting that
            // as "the debugger wouldn't attach" sends the user hunting a
            // problem that does not exist (FR-EX-012).
            reason = "cancelled";
          } else {
            const msg =
              "Couldn't emulate a mobile device — Chrome's debugger wouldn't attach. Close DevTools for this tab (and any other extension using the debugger), then start again.";
            await appendLog("error", "mobile-emulation-failed", { reason: msg });
            // On a RESUME, throwing would finalise the run as failed AND the
            // finally would clear the checkpoint — discarding a frontier with
            // potentially hundreds of states left over a transient attach error.
            // Cancel instead: the run ends, the work already uploaded is intact,
            // and nothing is silently mislabelled.
            if (resume) {
              reason = "cancelled";
              errorMessage = msg;
            } else {
              throw new Error(msg);
            }
          }
          return buildResult();
        }
      }
      if (!resume) {
        try {
          await injectDialogGuards(); // best-effort suppress on the pre-reload page
          await chrome.tabs.reload(tabId);
          await waitForLoad();
        } catch {
          /* best effort — guard + executeScript belt still apply */
        }
      }

      // FR-EX-011 — create a backend session when paired; upload is best-effort
      // and never blocks the crawl (the ZIP fallback always stays). A resume
      // re-adopts the checkpointed session id: creating one here would mint a
      // second session per eviction and strand the first as `running` forever.
      if (opts.projectId && !resume) {
        const created = await createSession(opts.projectId, opts.sessionOverrides);
        if (created.ok) {
          sessionId = created.sessionId;
          await updateSession(sessionId, { status: "running" });
        }
      }
      // Outside the block above so a resumed run re-arms its heartbeat too.
      if (sessionId) {
        heartbeatTimer = setInterval(() => {
          if (sessionId) void updateSession(sessionId, { heartbeat: true, stats: currentStats() });
        }, HEARTBEAT_MS);
      }
      // Armed for EVERY run, paired or not — an unpaired crawl can wedge just as
      // easily and has no heartbeat to go stale as evidence.
      watchdogTimer = setInterval(() => {
        if (this.isPaused || this._cancelled) {
          lastEmitAt = Date.now(); // a pause is not a stall; don't accrue against it
          return;
        }
        if (Date.now() - lastEmitAt < STALL_TIMEOUT_MS) return;
        void appendLog("error", "stalled", {
          idleMs: Date.now() - lastEmitAt,
          phase: lastProgress?.phase ?? "unknown",
          url: currentUrl,
        });
        this.cancel("self:stalled");
      }, STALL_CHECK_MS);

      let seeded = false;
      if (resume) {
        // The frontier came from the checkpoint; the tab is wherever the last
        // click left it and restore() will put us back. Only the page-level
        // guards and the badge need re-arming — they died with the worker.
        await injectDialogGuards();
        await installNet();
        try {
          await exec(tabId, applyRunBadge);
        } catch {
          /* best effort */
        }
        emit("resumed", queue.length);
        seeded = true;
      } else {
        // Seed: fingerprint the root FIRST (never seed an empty fp), then capture it.
        pages.add(loc.url);
        await injectDialogGuards(); // neutralise dialogs before we touch the page
        await installNet();
        try {
          await exec(tabId, applyRunBadge); // FR-EX-011 — show the "do not interact" badge
        } catch {
          /* best effort */
        }
        await waitStable();
        let first = await fingerprintNow();
        for (let tries = 0; !first && tries < 2; tries++) {
          await sleep(300);
          first = await fingerprintNow();
        }
        // The page may have crashed while loading (FR-EX-083) — try to recover once.
        if (!first && (await ensureTabAlive())) first = await fingerprintNow();

        if (!first) {
          reason = "error";
          errorMessage = tabCrashed
            ? "The page crashed before the crawl could start (Chrome 'Aw, Snap!'). Reload the tab and try again (EC-019)."
            : "Couldn't fingerprint the starting page. Reload the tab and try again.";
        } else {
          currentUrl = first.url;
          // Capture BEFORE marking visited (and before enqueueing): an eviction
          // between the two would resume with the state already flagged as seen
          // and never capture it — the screenshot would be gone for good (NFR-017).
          await captureState(
            first.fp,
            { url: first.url, title: first.title, viewport: first.viewport },
            0,
            null,
            null,
          );
          visitedStates.add(first.fp);
          // The root is its own replay anchor: every path is replayed from here.
          queue.push({ url: first.url, replayFrom: first.url, path: [], depth: 0, fp: first.fp });
          emit("start", queue.length); // first checkpoint of the run
          seeded = true;
        }
      }

      if (seeded) {
        bfs: while (queue.length > 0 && !this._cancelled) {
          if (overLimit()) {
            reason = "limit-reached";
            break;
          }
          await this.waitWhilePaused();
          if (this._cancelled) break;

          const state = queue.shift()!;
          // Hold the shifted state as the expansion cursor: the shift commits
          // nothing, so without this an eviction mid-expansion would drop it
          // from both the queue and the checkpoint. Resume unshifts it back
          // (triedPairs keeps the re-expansion from redoing any of its clicks).
          current = state;
          currentDepth = state.depth;
          maxDepthReached = Math.max(maxDepthReached, state.depth);

          // FR-EX-030 — a state AT the depth limit is a leaf. It was already
          // captured when it was enqueued; expanding it would click its elements
          // and capture whatever they open at maxDepth + 1 — one level deeper
          // than asked for. The enqueue gate further down never caught this: by
          // the time it says "don't queue the child", the child has already been
          // clicked into existence and photographed. maxDepth=1 explored depth 2;
          // maxDepth=0 explored depth 1. Every one of those clicks is a real
          // click on someone's live site, so the gate belongs HERE, before the
          // expansion, not after the capture.
          if (!canDescend(state.depth, maxDepth)) {
            current = null;
            emit("depth-limit", queue.length);
            continue;
          }

          // The root's first visit needs no restore — we're already there.
          // Never taken on resume: the tab is wherever the last click left it.
          if (firstDequeue && state.path.length === 0 && state.depth === 0) {
            firstDequeue = false;
          } else {
            if (!(await restore(state))) {
              current = null;
              // The big one: this state AND its whole unexplored subtree are gone.
              await abandon(
                state,
                "state",
                "couldn't get back to it — direct navigation or click-path replay diverged (FR-EX-061)",
              );
              emit("abandoned", queue.length);
              continue;
            }
          }

          // Expand every element of this state.
          let guard = 0;
          while (!this._cancelled) {
            if (++guard > EXPAND_GUARD) {
              await abandon(state, "expansion", `hit the ${EXPAND_GUARD}-element cap for one state`);
              break;
            }
            if (overLimit()) {
              reason = "limit-reached";
              break bfs;
            }
            await this.waitWhilePaused();
            if (this._cancelled) break;

            let disc: DiscoverResult | undefined;
            try {
              disc = await exec(tabId, discoverCandidates, {
                blocklist: opts.blocklist,
                excludeSelectors: opts.excludeSelectors ?? [], // FR-EX-026
                excludeUrlPatterns: opts.excludeUrlPatterns ?? [],
                siblingCollapseLimit: opts.siblingCollapseLimit ?? 2, // FR-EX-025
              });
            } catch {
              disc = undefined;
            }
            if (!disc) {
              await recordError("discover-failed", {
                message: "Couldn't read the clickable elements on the page.",
              });
              // FR-EX-083 — a crashed renderer can't be discovered; stop the run.
              if (!(await ensureTabAlive()) && tabCrashed) break bfs;
              break;
            }
            currentUrl = disc.url;
            pages.add(disc.url);

            // FR-EX-023 / C-04 — record cross-origin (or too-deeply-nested) iframes
            // as unreachable regions, once per state (the expand loop re-discovers
            // each cycle), and add them to the run-total the popup shows.
            if (disc.unreachableFrames > 0 && !unreachableLogged.has(state.fp)) {
              unreachableLogged.add(state.fp);
              unreachableRegions += disc.unreachableFrames;
              await appendLog("info", "unreachable-region", {
                url: disc.url,
                frames: disc.unreachableFrames,
                reason:
                  "iframe unreachable — cross-origin (content scripts can't cross the origin boundary, C-04) or nested past the frame-depth limit (FR-EX-023)",
              });
            }

            await logSkips(state.fp, disc.candidates); // FR-EX-026/034/084
            const next = pickNextForState(
              disc.candidates,
              triedPairs,
              state.fp,
              opts.safeMode,
              opts.clickSubmitEmptyForms,
              clicksByKey,
            );
            emit("discovered", queue.length);
            if (!next) break; // state fully expanded

            triedPairs.add(pairKey(state.fp, next.key));
            // Global click ledger — see MAX_CLICKS_PER_ELEMENT. Counted BEFORE
            // the click, same as triedPairs, so a resume after an unseen click
            // still charges it.
            const usedBefore = clicksByKey.get(next.key) ?? 0;
            clicksByKey.set(next.key, usedBefore + 1);
            if (usedBefore + 1 === MAX_CLICKS_PER_ELEMENT) {
              // Log on the LAST allowed click, not the first refusal: the refusal
              // happens inside a pure function that can't log, and this way the
              // truncation is visible in the FR-EX-084 stream either way.
              await appendLog("info", "element-click-cap", {
                url: currentUrl,
                selector: next.selector,
                text: next.text,
                cap: MAX_CLICKS_PER_ELEMENT,
                reason: "element hit its whole-run click cap — not clicked again",
              });
            }
            // FR-EX-080 write-ahead barrier — the pair MUST be durable before the
            // click, not after. emit("discovered") above fired before triedPairs
            // knew about this element, so resuming from that checkpoint would pick
            // the same element again and click it a second time. For a "Delete"
            // that Safe-mode didn't recognise, that second click is the damage this
            // engine exists to avoid. Conservative direction: after a resume, a
            // click whose outcome we never saw counts as already made — a lost edge
            // (FR-EX-041) beats a repeated destructive action (FR-EX-070).
            await checkpointNow();

            const trigger: ElementDescriptor = {
              selector: next.selector,
              text: next.text,
              tag: next.tag,
              role: next.role,
            };

            let clicked: { ok: boolean; reason?: string; filled?: number } | undefined;
            try {
              clicked = await exec(tabId, clickCandidate, {
                idx: next.idx,
                allowedDomains: scope,
                // FR-EX-035 — fill the form only for a submit the project opted to
                // click (next.submit is only reached here when clickSubmitEmptyForms
                // is on); a no-op on every ordinary click.
                fillForm: !!opts.formFillDummyData && next.submit,
                maskSelectors: opts.maskSelectors ?? [],
              });
            } catch {
              clicked = { ok: false, reason: "exec" };
            }
            if (!clicked?.ok) continue; // off-origin / gone — still on `state`, try next

            // FR-EX-084 — record the click itself. This is the decision the whole
            // log hangs off: every skip/dead-edge/dialog below is relative to a
            // click that DID fire, so a panel timeline is unreadable without it.
            await appendLog("info", "clicked", {
              url: currentUrl,
              selector: next.selector,
              text: next.text,
              tag: next.tag,
            });
            // FR-EX-035 / FR-EX-084 — a filled form leaves a trace.
            if (clicked.filled && clicked.filled > 0) {
              await appendLog("info", "form-filled", {
                url: currentUrl,
                selector: next.selector,
                fields: clicked.filled,
              });
            }

            await settleAfterClick(); // FR-EX-032 (nav-aware) + clickDelayMs
            await this.waitWhilePaused();
            if (this._cancelled) break;
            if (overLimit()) {
              reason = "limit-reached";
              break bfs;
            }

            const after = await fingerprintNow();
            if (!after) {
              await recordError("fingerprint-failed", {
                message: "Couldn't fingerprint the UI state after a click.",
              });
              // FR-EX-083 — distinguish a crashed renderer from a transient miss.
              if (!(await ensureTabAlive()) && tabCrashed) break bfs;
              if (!(await restore(state))) {
                await abandon(state, "expansion", "couldn't get back after a failed fingerprint");
                break; // recover to a known state
              }
              continue;
            }
            // Scope escape guard (FR-EX-010/071) — use the fingerprint's own URL
            // (no TOCTOU vs a separate getLocation) and never capture off-scope.
            if (!isInScope(after.url, scope)) {
              if (!(await restore(state))) {
                await abandon(state, "expansion", "couldn't get back after an off-scope navigation");
                break;
              }
              continue;
            }

            if (after.fp === state.fp) {
              deadEdges++; // click produced no state change (EC-016) — still on `state`
              edgeBuffer.push({ fromFingerprint: state.fp, toFingerprint: null, element: trigger, kind: "dead" });
              await appendLog("info", "dead-edge", { url: currentUrl, selector: next.selector, text: next.text }); // FR-EX-084
              emit("dead-edge", queue.length);
              continue;
            }

            edges++;
            const sameUrl = normalizeUrl(after.url) === normalizeUrl(state.url);
            edgeBuffer.push({
              fromFingerprint: state.fp,
              toFingerprint: after.fp,
              element: trigger,
              kind: edgeKind(state.fp, after.fp, sameUrl),
            });
            if (edgeBuffer.length >= 100) await flushEdges();

            if (!visitedStates.has(after.fp)) {
              maxDepthReached = Math.max(maxDepthReached, state.depth + 1);
              // Capture first, mark visited second. An eviction between the two
              // must leave the state looking UNvisited: the worst case is then a
              // re-capture (which the dedupe absorbs), whereas the other order
              // would resume with the state marked seen and its screenshot never
              // taken — silent, permanent loss (NFR-017).
              await captureState(
                after.fp,
                { url: after.url, title: after.title, viewport: after.viewport },
                state.depth + 1,
                state.fp,
                trigger,
              );
              visitedStates.add(after.fp);
              // Belt: the dequeue gate above means we only ever expand a state
              // that may descend, so this is always true today. Kept so the bound
              // survives if that gate is ever moved or relaxed.
              if (canDescend(state.depth, maxDepth)) {
                queue.push(childState(state, after, next));
              }
              emit("captured", queue.length);
            } else {
              emit("known-state", queue.length);
            }

            // FR-EX-062 — the click opened a modal, now captured as its own state.
            // Close it (Escape, then in-dialog close controls) so the underlying
            // page is reachable again. An unclosable one is left for restore()
            // below to escape by re-navigation. Best-effort; logged either way.
            if (after.dialogs > 0) {
              const dismiss = await exec(tabId, closeTopModal);
              if (dismiss?.hadModal) {
                await appendLog("info", "dialog-dismissed", {
                  url: after.url,
                  closed: dismiss.closed,
                  method: dismiss.method || "none",
                });
              }
            }

            // We moved off `state` — return to it to try its remaining elements.
            if (!(await restore(state))) {
              await abandon(state, "expansion", "couldn't get back after exploring a child state");
              break;
            }
          }
          // `state` is done (fully expanded, or abandoned by any of the inner
          // breaks). One clear point for every non-terminal exit keeps the
          // invariant that a resume behaves as if the eviction hadn't happened.
          // The `break bfs` paths skip this deliberately: they're terminal, and
          // the finally clears the whole checkpoint anyway.
          //
          // The clear has to be PERSISTED here, not just made in memory: the next
          // write would otherwise be emit("discovered") for the *following* state,
          // leaving this finished one as `current` across the whole restore in
          // between — and an eviction there would resume, unshift it back and
          // re-expand it with a fresh EXPAND_GUARD budget, which for a state that
          // broke on the guard means 500 more real clicks.
          current = null;
          checkpoint();
        }

        if (tabClosed) {
          reason = "error";
          errorMessage = "The crawl tab was closed — finalised with partial results (EC-019).";
        } else if (tabCrashed) {
          reason = "error";
          errorMessage =
            "The page crashed mid-crawl (Chrome 'Aw, Snap!') and couldn't be recovered — finalised with the screenshots captured so far (EC-019 / FR-EX-083).";
        } else if (this._cancelled) reason = "cancelled";
        else if (reason !== "limit-reached") reason = "completed";
      }
    } catch (e) {
      reason = "error";
      const raw = e instanceof Error ? e.message : String(e);
      // Belt (FR-EX-083) — never surface Chrome's raw dead-frame string
      // ("Frame with ID 0 was removed.") if an unguarded call still throws it.
      errorMessage = isDeadTabError(raw)
        ? "The page crashed or was closed mid-crawl (Chrome 'Aw, Snap!') — finalised with partial results (EC-019 / FR-EX-083)."
        : raw;
    } finally {
      // Release the upload abort BEFORE the finalisation calls below. Stop must
      // kill the crawl loop's uploads instantly, but the tail (edges, logs, the
      // terminal status PATCH) has to be allowed to land — losing the record of
      // what a run did is worse than a few seconds of "stopping…". Each request
      // still carries its own REQUEST_TIMEOUT_MS, so this cannot hang shutdown.
      setRunAbortSignal(null);
      // FR-EX-090 — hand the tab back at its real size. Detaching is what
      // actually resets emulation; leaving the user's tab stuck at phone width
      // would be a nasty parting gift.
      try {
        chrome.debugger.onDetach.removeListener(onDebuggerDetach);
      } catch {
        /* never added */
      }
      await stopMobileEmulation();
      // FR-EX-080 — drop the checkpoint FIRST, before the slow network calls
      // below. The run is over; if the worker dies partway through this block,
      // losing a status PATCH is recoverable (the heartbeat goes stale), whereas
      // a surviving checkpoint would have the alarm resurrect a finished crawl
      // and start clicking the tab again. Stop accepting new writes and let the
      // queued ones land before the clear, or one of them recreates what we just
      // deleted.
      ckptClosed = true;
      await ckptChain.catch(() => {});
      await clearCheckpoint();
      removeScopeGuard();
      await unregisterDialogGuard(); // FR-EX-073 — drop the document_start guard
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      // FR-EX-082 — record the terminal failure (crash, closed tab, seed failure)
      // so it shows in "View errors" and the panel log alongside the per-step ones.
      if (reason === "error" && errorMessage) {
        await appendLog("error", "run-failed", { message: errorMessage });
      }
      // Say WHO stopped the run. `cancelled` used to cover both a user pressing
      // Stop and the engine self-cancelling (off-scope redirect loop, stall
      // watchdog); once Stop is the normal ending, conflating them makes a run
      // undiagnosable. The endReason enum is unchanged — this rides in the log.
      if (reason === "cancelled" && this.cancelSource !== "user") {
        await appendLog("warn", "self-cancelled", { source: this.cancelSource });
      }
      await flushEdges();
      await flushLogs();
      if (sessionId) {
        const { status, endReason } = mapReason(reason);
        try {
          await updateSession(sessionId, { status, endReason, stats: currentStats() });
        } catch {
          /* best effort */
        }
      }
      try {
        // RAW execScript, not the cancel-racing `exec`: on a Stop the marks must
        // still come off the user's page, and the raced wrapper would resolve
        // `undefined` without running (FR-EX-012). Its own EXEC_TIMEOUT still
        // bounds it, so this can't hang the shutdown.
        await execScript(tabId, cleanupMarks);
      } catch {
        /* best-effort */
      }
    }

    return buildResult();
  }
}
