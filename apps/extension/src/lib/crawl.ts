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
// Not yet resilient to SW eviction: an active crawl keeps the SW alive (it's
// continuously busy), but checkpoint/resume across eviction is a later slice
// (FR-EX-080/060, C-03).

import {
  applyMasks,
  applyRunBadge,
  cleanupMarks,
  clickCandidate,
  discoverCandidates,
  extractStateSignature,
  getLocation,
  installNetworkCounter,
  neutralizeDialogsInPage,
  removeMasks,
  setRunBadgeVisible,
  waitForStable,
  type DiscoverResult,
  type InjectedCandidate,
} from "../content/crawl-inject";
import { computeFingerprint, normalizeUrl } from "./fingerprint";
import { DEFAULT_DESTRUCTIVE_BLOCKLIST } from "@snapcrawl/shared/constants";
import type {
  CaptureMeta,
  CrawlConfig,
  EdgeInput,
  ElementDescriptor,
  SessionEndReason,
  SessionLogInput,
  SessionOverrides,
  SessionStats,
  SessionStatus,
} from "@snapcrawl/shared";
import { edgeKind } from "./upload";
import { putCrawlShot, resetCrawlShots } from "./capture-sink";
import { putCrawlError, resetCrawlErrors } from "./error-sink";
import { createSession, updateSession, uploadCapture, uploadEdges, uploadLogs } from "./crawl-upload";
import { effectiveAllowedDomains, isInScope } from "./scope";
import { crawlOrigins, injectionErrorMessage } from "./host-access";

/** Default run-override values surfaced in the popup. */
export const DEFAULT_MAX_SCREENS = 40;
export const DEFAULT_MAX_DEPTH = 4;
export const DEFAULT_MAX_MINUTES = 10;

const CAPTURE_SPACING_MS = 600; // C-01 / FR-EX-050: ≥ 600 ms between captures.
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
  maxScreens: number;
  maxDepth: number;
  maxDurationMin: number;
  clickDelayMs?: number;
  safeMode: boolean;
  blocklist: string[];
  fullPage: boolean;
  /** Domains the crawl may touch (FR-EX-010/071); [] ⇒ derive from the start URL. */
  allowedDomains?: string[];
  /** Elements masked with opaque overlays before each capture (FR-EX-053). */
  maskSelectors?: string[];
  /** When set (paired), a backend session is created and captures upload (FR-EX-011/081). */
  projectId?: string;
  sessionOverrides?: SessionOverrides;
  /** The current tab to drive in place (FR-EX-011). Falls back to the active tab. */
  target?: { tabId: number; windowId: number };
}

/** Per-run overrides the popup exposes on top of the project config (FR-EX-014). */
export interface RunOverrides {
  maxScreens: number;
  maxDepth: number;
  maxMinutes: number;
  fullPage: boolean;
}

/**
 * Build the crawl options from a project's config (FR-EX-002) plus per-run
 * overrides and the Safe-mode toggle. The blocklist and clickDelay come from the
 * project config; limits are the (config-seeded, user-tweakable) overrides.
 * Falls back to the default blocklist when unpaired (config === null). Pure.
 */
export function configToRunOptions(
  config: CrawlConfig | null,
  overrides: RunOverrides,
  safeMode: boolean,
): CrawlOptions {
  return {
    maxScreens: overrides.maxScreens,
    maxDepth: overrides.maxDepth,
    maxDurationMin: overrides.maxMinutes,
    clickDelayMs: config?.clickDelayMs,
    safeMode,
    blocklist: config?.destructiveTextBlocklist ?? [...DEFAULT_DESTRUCTIVE_BLOCKLIST],
    fullPage: overrides.fullPage,
    maskSelectors: config?.maskSelectors ?? [],
    allowedDomains: config?.allowedDomains ?? [],
  };
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
}

export interface CrawlResult {
  /** Number of screenshots captured (stored via the sink, not held in memory). */
  captures: number;
  reason: CrawlReason;
  states: number;
  pages: number;
  edges: number;
  deadEdges: number;
  /** How many captures were uploaded to the backend (0 when unpaired). */
  uploaded: number;
  sessionId: string | null;
  error?: string;
}

/** A recorded click, enough to re-find the element on replay (FR-EX-061). */
export interface ClickStep {
  key: string;
  tag: string;
  role: string | null;
  text: string;
  href: string | null;
}

/** A node in the BFS frontier. */
export interface QueuedState {
  url: string;
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
): InjectedCandidate | null {
  for (const c of candidates) {
    if (safeMode && c.destructive) continue;
    if (triedPairs.has(pairKey(stateFp, c.key))) continue;
    return c;
  }
  return null;
}

export function pairKey(stateFp: string, elementKey: string): string {
  return `${stateFp}::${elementKey}`;
}

/**
 * Re-find a recorded element among freshly-discovered candidates: exact key
 * first, then a tag/role/text fallback. Null ⇒ replay diverged (FR-EX-061). Pure.
 */
export function matchCandidate(
  candidates: InjectedCandidate[],
  step: ClickStep,
): InjectedCandidate | null {
  for (const c of candidates) if (c.key === step.key) return c;
  for (const c of candidates) {
    if (
      c.tag === step.tag &&
      (c.role ?? "") === (step.role ?? "") &&
      c.text === step.text &&
      (c.href ?? "") === (step.href ?? "")
    )
      return c;
  }
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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const EXEC_TIMEOUT_MS = 10000; // an injection blocked by a native dialog can't hang the loop forever

/** Resolve `p`, or `undefined` if it doesn't settle within `ms` (never hangs). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

async function exec<A, R>(
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

/** Same as `exec`, but in the page's MAIN world (for the network monkey-patch). */
async function execMain<A, R>(
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

  cancel(): void {
    this._cancelled = true;
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
    while (this._paused && !this._cancelled) await sleep(150);
  }

  async run(opts: CrawlOptions, onProgress: (p: CrawlProgress) => void): Promise<CrawlResult> {
    const clickDelayMs = opts.clickDelayMs ?? DEFAULT_CLICK_DELAY_MS;
    const maxDurationMs = opts.maxDurationMin > 0 ? opts.maxDurationMin * 60_000 : Infinity;

    const empty = (error?: string): CrawlResult => ({
      captures: 0,
      reason: "no-tab",
      states: 0,
      pages: 0,
      edges: 0,
      deadEdges: 0,
      uploaded: 0,
      sessionId: null,
      ...(error ? { error } : {}),
    });

    // Drive the current tab (FR-EX-011). Only falls back to querying the active
    // tab if no target was given (legacy path; the SW always passes one).
    let tabId: number;
    let windowId: number;
    if (opts.target) {
      tabId = opts.target.tabId;
      windowId = opts.target.windowId;
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return empty();
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
      return empty(injectionErrorMessage(tabUrl));
    }

    // FR-EX-010/071 — the domains this run may touch. Empty config ⇒ confine to
    // the start URL's host so a crawl never wanders off-site.
    const scope = effectiveAllowedDomains(opts.allowedDomains, loc.url);
    // Authoritative scope gate: never seed/capture an off-scope tab, even if the
    // popup Start-gate was stale (the tab redirected off-scope while it was open).
    if (!isInScope(loc.url, scope)) {
      return empty("The active tab isn't in this project's allowed domains — open an in-scope page.");
    }
    const visitedStates = new Set<string>(); // fingerprints captured (FR-EX-041)
    const triedPairs = new Set<string>(); // `${stateFp}::${elementKey}` (never re-click)
    const pages = new Set<string>();
    const edgeBuffer: EdgeInput[] = []; // buffered edges → /ext/edges (FR-BE-045)
    let errors = 0;
    let edges = 0;
    let deadEdges = 0;
    let captureCount = 0;
    let uploaded = 0;
    let duplicatesSkipped = 0;
    let maxDepthReached = 0;
    let currentUrl = loc.url;
    let currentDepth = 0;
    let lastCaptureAt = 0;
    let sessionId: string | null = null;
    let uploadsSuspended = false;
    let tabClosed = false; // EC-019 — set if the user closes the crawl tab mid-run
    let tabCrashed = false; // EC-019 / FR-EX-083 — set if the renderer crashes ("Aw, Snap!")
    let crashRecoveries = 0; // bounded reload attempts after a renderer crash
    const startedAt = Date.now();

    await resetCrawlShots(); // FR-EX-055 — clear any shots from a previous run
    await resetCrawlErrors(); // FR-EX-082 — clear any errors from a previous run

    const logBuffer: SessionLogInput[] = []; // buffered error log → /ext/logs (FR-EX-084)

    const emit = (phase: string, queueLen: number) =>
      onProgress({
        screens: captureCount,
        states: visitedStates.size,
        depth: currentDepth,
        queue: queueLen,
        pages: pages.size,
        errors,
        currentUrl,
        phase,
      });

    const overLimit = (): boolean =>
      limitReason({
        shots: captureCount,
        maxScreens: opts.maxScreens,
        elapsedMs: Date.now() - startedAt - this.pausedMs(), // exclude paused time
        maxDurationMs,
      }) !== null;

    const currentStats = (): Partial<SessionStats> => ({
      screensCaptured: captureCount,
      edgesRecorded: edges,
      duplicatesSkipped,
      errorsCount: errors,
      maxDepthReached,
      currentUrl,
    });

    const flushEdges = async (): Promise<void> => {
      if (!sessionId) return;
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
      const gap = CAPTURE_SPACING_MS - (Date.now() - lastCaptureAt);
      if (gap > 0) await sleep(gap);

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

      // FR-EX-053 — cover PII before the shot; also hide the run badge so neither
      // reaches the image. Both are restored afterwards.
      try {
        await exec(tabId, applyMasks, { selectors: opts.maskSelectors ?? [] });
        await exec(tabId, setRunBadgeVisible, { visible: false });
      } catch {
        /* best effort */
      }
      let dataUrl: string | undefined;
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      } catch {
        await sleep(CAPTURE_SPACING_MS + 100); // EC-013 backoff
        try {
          dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
        } catch {
          dataUrl = undefined;
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
      if (!dataUrl) {
        // FR-EX-050/EC-013 — capture failed even after the backoff retry. Common
        // cause: the crawl window lost focus (C-01), so captureVisibleTab is denied.
        await recordError("capture-failed", {
          message: "Screenshot capture returned no image (window may have lost focus — C-01).",
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
        viewport: page.viewport,
        fullPage: opts.fullPage,
        clientTimestamp: new Date(),
      };

      // FR-EX-081 — upload via the SW. Offline queue full ⇒ suspend uploads
      // (captures still land in storage, so the ZIP fallback stays intact).
      if (sessionId && !uploadsSuspended) {
        const r = await uploadCapture({
          sessionId,
          stateFingerprint: fp,
          contentType: "image/png",
          dataUrl,
          meta,
        });
        if (r.ok) {
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
    // Neutralise dialogs as soon as each navigation commits (registered with the
    // other run listeners in installScopeGuard).
    const onCommitted = (d: { tabId: number }): void => {
      if (d.tabId === tabId) void injectDialogGuards();
    };

    // FR-EX-073 / EC-022 — the authoritative dialog suppressor. Register the
    // MAIN-world guard (public/dialog-guard.js) at document_start for the crawl
    // scope so it runs BEFORE any page script and the page can never arm a
    // beforeunload "Leave site?" prompt (which would block the crawl's own
    // navigations). executeScript at document_idle is too late for a handler the
    // page registered at load, since window beforeunload listeners fire in
    // registration order — hence a real content-script registration.
    const registerDialogGuard = async (): Promise<void> => {
      const matches = crawlOrigins(loc.url, scope);
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

    // FR-EX-061 (bounded) — return to a state: navigate to its URL, replay its
    // click path, verify the fingerprint. false ⇒ branch abandoned.
    const restore = async (s: QueuedState): Promise<boolean> => {
      // Never navigate out of the allowed domains (FR-EX-010/071).
      if (!isInScope(s.url, scope)) return false;
      try {
        await chrome.tabs.update(tabId, { url: s.url });
      } catch {
        return false;
      }
      await sleep(300); // let the navigation actually start
      await waitForLoad();
      await installNet();
      await waitStable();
      if (this._cancelled) return false;

      for (const step of s.path) {
        if (this._cancelled) return false;
        let disc: DiscoverResult | undefined;
        try {
          disc = await exec(tabId, discoverCandidates, { blocklist: opts.blocklist });
        } catch {
          disc = undefined;
        }
        if (!disc) return false;
        const cand = matchCandidate(disc.candidates, step);
        if (!cand) return false; // divergence → abandon
        if (opts.safeMode && cand.destructive) return false; // FR-EX-070 — never replay-click destructive
        let clicked: { ok: boolean } | undefined;
        try {
          clicked = await exec(tabId, clickCandidate, { idx: cand.idx, allowedDomains: scope });
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
      };
      // Route-addressable child ⇒ empty path (nav restores it directly);
      // same-URL sub-state ⇒ extend the parent's replay path.
      if (normalizeUrl(after.url) !== normalizeUrl(parent.url)) {
        return { url: after.url, path: [], depth: parent.depth + 1, fp: after.fp };
      }
      return { url: parent.url, path: [...parent.path, desc], depth: parent.depth + 1, fp: after.fp };
    };

    // FR-EX-071 — auto-close out-of-scope tabs/windows the CRAWL spawns during
    // THIS run only. We track spawned tab ids in a per-run set (never acting on
    // a tab merely because its opener is the crawl tab), so the user's own
    // pre-existing tabs are never touched — even if they were opened from the
    // crawl tab earlier.
    const spawned = new Set<number>();
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
    const installScopeGuard = (): void => {
      try {
        chrome.tabs.onCreated.addListener(onTabCreated);
        chrome.tabs.onUpdated.addListener(onTabUpdated);
        chrome.tabs.onRemoved.addListener(onTabRemoved);
        chrome.webNavigation.onCreatedNavigationTarget.addListener(onNavTarget);
        chrome.webNavigation.onCommitted.addListener(onCommitted);
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
      } catch {
        /* ignore */
      }
    };

    let reason: CrawlReason = "completed";
    let errorMessage: string | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    installScopeGuard();
    try {
      // FR-EX-073 — arm the document_start beforeunload guard for the scope, then
      // reload the seed tab so the already-open page comes back UNDER the guard.
      // The reload happens before any crawl interaction, so the current page's own
      // beforeunload can't prompt (no user gesture on it yet); we still neutralise
      // it first as a belt. After this, every page the crawl loads is guarded.
      await registerDialogGuard();
      try {
        await injectDialogGuards(); // best-effort suppress on the pre-reload page
        await chrome.tabs.reload(tabId);
        await waitForLoad();
      } catch {
        /* best effort — guard + executeScript belt still apply */
      }

      // FR-EX-011 — create a backend session when paired; upload is best-effort
      // and never blocks the crawl (the ZIP fallback always stays).
      if (opts.projectId) {
        const created = await createSession(opts.projectId, opts.sessionOverrides);
        if (created.ok) {
          sessionId = created.sessionId;
          await updateSession(sessionId, { status: "running" });
          heartbeatTimer = setInterval(() => {
            if (sessionId) void updateSession(sessionId, { heartbeat: true, stats: currentStats() });
          }, HEARTBEAT_MS);
        }
      }

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
        visitedStates.add(first.fp);
        currentUrl = first.url;
        await captureState(first.fp, { url: first.url, title: first.title, viewport: first.viewport }, 0, null, null);
        emit("start", 0);

        const queue: QueuedState[] = [{ url: first.url, path: [], depth: 0, fp: first.fp }];
        let firstDequeue = true;

        bfs: while (queue.length > 0 && !this._cancelled) {
          if (overLimit()) {
            reason = "limit-reached";
            break;
          }
          await this.waitWhilePaused();
          if (this._cancelled) break;

          const state = queue.shift()!;
          currentDepth = state.depth;
          maxDepthReached = Math.max(maxDepthReached, state.depth);

          // The root's first visit needs no restore — we're already there.
          if (firstDequeue && state.path.length === 0 && state.depth === 0) {
            firstDequeue = false;
          } else {
            if (!(await restore(state))) {
              emit("abandoned", queue.length);
              continue;
            }
          }

          // Expand every element of this state.
          let guard = 0;
          while (!this._cancelled) {
            if (++guard > EXPAND_GUARD) break;
            if (overLimit()) {
              reason = "limit-reached";
              break bfs;
            }
            await this.waitWhilePaused();
            if (this._cancelled) break;

            let disc: DiscoverResult | undefined;
            try {
              disc = await exec(tabId, discoverCandidates, { blocklist: opts.blocklist });
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

            const next = pickNextForState(disc.candidates, triedPairs, state.fp, opts.safeMode);
            emit("discovered", queue.length);
            if (!next) break; // state fully expanded

            triedPairs.add(pairKey(state.fp, next.key));
            const trigger: ElementDescriptor = {
              selector: next.selector,
              text: next.text,
              tag: next.tag,
              role: next.role,
            };

            let clicked: { ok: boolean; reason?: string } | undefined;
            try {
              clicked = await exec(tabId, clickCandidate, { idx: next.idx, allowedDomains: scope });
            } catch {
              clicked = { ok: false, reason: "exec" };
            }
            if (!clicked?.ok) continue; // off-origin / gone — still on `state`, try next

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
              if (!(await restore(state))) break; // recover to a known state
              continue;
            }
            // Scope escape guard (FR-EX-010/071) — use the fingerprint's own URL
            // (no TOCTOU vs a separate getLocation) and never capture off-scope.
            if (!isInScope(after.url, scope)) {
              if (!(await restore(state))) break;
              continue;
            }

            if (after.fp === state.fp) {
              deadEdges++; // click produced no state change (EC-016) — still on `state`
              edgeBuffer.push({ fromFingerprint: state.fp, toFingerprint: null, element: trigger, kind: "dead" });
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
              visitedStates.add(after.fp);
              maxDepthReached = Math.max(maxDepthReached, state.depth + 1);
              await captureState(
                after.fp,
                { url: after.url, title: after.title, viewport: after.viewport },
                state.depth + 1,
                state.fp,
                trigger,
              );
              if (canDescend(state.depth, opts.maxDepth)) {
                queue.push(childState(state, after, next));
              }
              emit("captured", queue.length);
            } else {
              emit("known-state", queue.length);
            }

            // We moved off `state` — return to it to try its remaining elements.
            if (!(await restore(state))) break;
          }
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
      removeScopeGuard();
      await unregisterDialogGuard(); // FR-EX-073 — drop the document_start guard
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      // FR-EX-082 — record the terminal failure (crash, closed tab, seed failure)
      // so it shows in "View errors" and the panel log alongside the per-step ones.
      if (reason === "error" && errorMessage) {
        await appendLog("error", "run-failed", { message: errorMessage });
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
        await exec(tabId, cleanupMarks);
      } catch {
        /* best-effort */
      }
    }

    return {
      captures: captureCount,
      reason,
      states: visitedStates.size,
      pages: pages.size,
      edges,
      deadEdges,
      uploaded,
      sessionId,
      ...(errorMessage ? { error: errorMessage } : {}),
    };
  }
}
