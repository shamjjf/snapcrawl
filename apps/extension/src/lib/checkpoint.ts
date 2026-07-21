// Crawl checkpoint store (FR-EX-080) — how a crawl survives MV3 (C-03, EC-012).
//
// The service worker is killed after ~30 s idle, taking every closure local in
// CrawlController.run() with it: the frontier queue, the visited/tried sets, the
// click paths, the run config. Checkpointing them after every state transition
// lets a woken worker rebuild the run and carry on (see resumeCrawl in the
// background worker).
//
// Eviction is not exotic here — it is what Pause does. waitWhilePaused() is a
// bare sleep loop with no chrome.* call, and MV3's idle timer is only reset by
// events and extension API calls, so a pause longer than ~30 s all but
// guarantees eviction. A *running* crawl mostly keeps itself alive through its
// own executeScript/tabs traffic.
//
// Two areas, two jobs (the SRS's "session, mirrored to local"):
//   • storage.session — authoritative, in-memory, written on every transition.
//   • storage.local   — throttled mirror. NEVER a resume source (see below);
//                       it exists so a browser restart can finalise the orphaned
//                       backend session instead of leaving it `running` forever.
//
// Why the mirror must never resume: storage.session dies with the browser, the
// mirror doesn't, and tab IDs restart their counter each browser session. A
// mirrored `tabId: 42` would very likely resolve to some unrelated tab in the
// next session — and the crawl would start clicking it. `sessionNonce` is minted
// per worker session in storage.session, so a mirror read can be positively
// rejected rather than merely looking plausible.
//
// Like the other sinks (capture-sink, error-sink) every access is wrapped so a
// storage failure can never throw into the engine.

import type { CrawlOptions, CrawlProgress, QueuedState } from "./crawl";
import type { EdgeInput, SessionLogInput } from "@snapcrawl/shared";

const CHECKPOINT_KEY = "sc-crawl-checkpoint";
const NONCE_KEY = "sc-crawl-nonce";

/** Current schema version. A mismatch is discarded: never resume a run whose
 *  engine has changed under it (the queue/fp semantics may differ).
 *
 *  v2: QueuedState gained `replayFrom` (FR-EX-061). A v1 checkpoint's states have
 *  no anchor, so a resumed run would navigate to `undefined` on its first restore.
 *  This is exactly the case the version guard exists for.
 *
 *  v3: element keys are now the FR-EX-024 fingerprint (robust path + hash), not
 *  `tag|role|text|href|selector`. Every key in a v2 checkpoint's `triedPairs` and
 *  every `path[].key` is in the old alphabet, so a resumed run would find no pair
 *  tried and re-click the entire site — including anything it had already
 *  decided, at the cost of real clicks on a real target. */
/** v4: limits became `number | null` and the click ledger was added. A v3
 *  checkpoint has no clicksByKey, so resuming one would restart an unbounded
 *  generator's loop with a clean ledger — discard in-flight runs instead. */
export const CHECKPOINT_VERSION = 4;

/** How stale a checkpoint may be and still auto-resume a RUNNING crawl. Past
 *  this we finalise instead: a crawl that woke hours later (laptop sleep) would
 *  otherwise seize a tab the user has long since moved on to. A PAUSED crawl is
 *  exempt — it clicks nothing until the user resumes it. */
export const RESUME_MAX_GAP_MS = 5 * 60_000;

/** Mirror writes hit disk, so they stay off the click path (the session write is
 *  in-memory and always synchronous with the transition). */
export const MIRROR_THROTTLE_MS = 2000;

/** One log line, JSON-safe. SessionLogInput.at is a Date; storage.local
 *  JSON-serialises it to a string while storage.session may keep it a Date —
 *  a checkpoint whose type depends on which mirror you read is worse than
 *  either, so the wire form here is always epoch-ms. */
export interface CheckpointLogLine {
  level: "error" | "warn" | "info";
  event: string;
  context?: unknown;
  at?: number;
}

/** Everything needed to rebuild a run() in a fresh service worker (FR-EX-080). */
export interface CrawlCheckpoint {
  v: number;
  /** Monotonic write counter — a slow write must never clobber a newer one. */
  seq: number;
  /** Epoch-ms of this write; drives the RESUME_MAX_GAP_MS rule. */
  at: number;
  /** Worker-session nonce — rejects a local-mirror read as a resume source. */
  sessionNonce: string;

  // Run config (FR-EX-080 "run config").
  opts: CrawlOptions;
  /** RESOLVED allowed domains. Never re-derived on resume: the fallback derives
   *  scope from the CURRENT url's host, and a drifted tab would silently widen
   *  the crawl's scope (FR-EX-010/071). */
  scope: string[];
  seedUrl: string;

  // Frontier + click paths (FR-EX-080 "queue", "click-path map").
  queue: QueuedState[];
  /** The state shifted off the queue but not yet fully expanded. Unshifted back
   *  on resume so a mid-expansion eviction doesn't drop it. */
  current: QueuedState | null;

  // Visited sets (FR-EX-080 "visited set"). Sets don't survive JSON.
  visitedStates: string[];
  triedPairs: string[];
  /** Whole-run per-element click counts, as [key, count] pairs (Maps don't
   *  survive JSON). Resetting this on resume would let an unbounded generator
   *  start its loop over after every service-worker eviction. */
  clicksByKey: [string, number][];
  pages: string[];

  // Counters.
  errors: number;
  edges: number;
  deadEdges: number;
  /** Branches given up on (FR-EX-084) — checkpointed so an eviction can't reset
   *  the one number that says how much of the site the run actually missed. */
  abandoned: number;
  /** FR-EX-023 — cross-origin / too-deep iframe regions left uncrawled, run-total. */
  unreachableRegions: number;
  uploaded: number;
  duplicatesSkipped: number;
  maxDepthReached: number;
  currentDepth: number;
  currentUrl: string;

  /** ACTIVE run time — paused and evicted time excluded. Replaces `startedAt`:
   *  restoring that verbatim would charge the whole eviction gap to
   *  maxDurationMin, so a 20-min gap on a 10-min budget makes the resumed run
   *  report limit-reached on its first check — useless in exactly the case this
   *  requirement exists for. */
  elapsedMs: number;
  /** Resume into the state the user chose; never un-pause their crawl. */
  paused: boolean;

  sessionId: string | null;
  uploadsSuspended: boolean;

  // Unflushed batches — dropped on eviction otherwise.
  edgeBuffer: EdgeInput[];
  logBuffer: CheckpointLogLine[];

  spawned: number[];
  crashRecoveries: number;

  /** Lets the popup see a live crawl before the resume finishes rebuilding it. */
  progress: CrawlProgress;
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** SessionLogInput.at (Date) → epoch-ms for storage. Pure. */
export function serializeLogBuffer(lines: SessionLogInput[]): CheckpointLogLine[] {
  return lines.map((l) => ({ ...l, at: l.at?.getTime() }));
}

/** epoch-ms → Date, back into the shape uploadLogs expects. Pure. */
export function deserializeLogBuffer(lines: CheckpointLogLine[]): SessionLogInput[] {
  return lines.map((l) => ({ ...l, at: l.at === undefined ? undefined : new Date(l.at) }));
}

/** Why a checkpoint can't be resumed — or null when it can. Pure, so the resume
 *  gate is testable without a browser. */
export type ResumeVeto = "version" | "nonce" | "stale" | "no-target" | "no-frontier";

export function resumeVeto(
  c: CrawlCheckpoint,
  nonce: string,
  now: number,
  maxGapMs: number = RESUME_MAX_GAP_MS,
): ResumeVeto | null {
  if (c.v !== CHECKPOINT_VERSION) return "version";
  if (!c.sessionNonce || c.sessionNonce !== nonce) return "nonce";
  if (!c.opts.target) return "no-target";
  // Nothing left to expand. A live run always has a frontier (the shifted state
  // is held in `current`), so this means the eviction landed in the seeding
  // window, before the root made it into the queue. Resuming would drain
  // immediately and report a tidy `completed` for a crawl that never ran — so
  // veto, and let the caller finalise it honestly as failed.
  if (c.queue.length === 0 && !c.current) return "no-frontier";
  // A paused crawl drives nothing until the user resumes, so staleness is
  // harmless — and pause is the likeliest way to get evicted in the first place.
  if (!c.paused && now - c.at > maxGapMs) return "stale";
  return null;
}

/** True when this checkpoint may rebuild a controller. Pure. */
export function isResumable(
  c: CrawlCheckpoint,
  nonce: string,
  now: number,
  maxGapMs: number = RESUME_MAX_GAP_MS,
): boolean {
  return resumeVeto(c, nonce, now, maxGapMs) === null;
}

/** Shallow structural check on whatever came back out of storage. */
function looksLikeCheckpoint(v: unknown): v is CrawlCheckpoint {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Partial<CrawlCheckpoint>;
  return (
    typeof c.v === "number" &&
    typeof c.seq === "number" &&
    typeof c.at === "number" &&
    Array.isArray(c.queue) &&
    Array.isArray(c.visitedStates) &&
    Array.isArray(c.triedPairs) &&
    typeof c.opts === "object" &&
    c.opts !== null
  );
}

// ── Storage ────────────────────────────────────────────────────────────────

/** The worker-session nonce, minted once per worker session and kept in
 *  storage.session so it dies with the browser — which is exactly what makes it
 *  a trustworthy discriminator for the local mirror. */
export async function getSessionNonce(): Promise<string> {
  try {
    const r = await chrome.storage.session.get(NONCE_KEY);
    const existing = r[NONCE_KEY];
    if (typeof existing === "string" && existing) return existing;
    const minted = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await chrome.storage.session.set({ [NONCE_KEY]: minted });
    return minted;
  } catch {
    return "";
  }
}

/** Read the authoritative checkpoint. storage.session ONLY — see the header. */
export async function readCheckpoint(): Promise<CrawlCheckpoint | null> {
  try {
    const r = await chrome.storage.session.get(CHECKPOINT_KEY);
    const v = r[CHECKPOINT_KEY];
    return looksLikeCheckpoint(v) ? v : null;
  } catch {
    return null;
  }
}

/** Read the local mirror. ONLY for post-mortem work (finalising an orphaned
 *  session after a browser restart) — never to resume a run. */
export async function readCheckpointMirror(): Promise<CrawlCheckpoint | null> {
  try {
    const r = await chrome.storage.local.get(CHECKPOINT_KEY);
    const v = r[CHECKPOINT_KEY];
    return looksLikeCheckpoint(v) ? v : null;
  } catch {
    return null;
  }
}

let lastMirrorAt = 0;

/**
 * Persist a checkpoint: session synchronously (authoritative, in-memory, cheap),
 * local throttled (disk). `force` bypasses the mirror throttle for callers that
 * need it written now.
 *
 * The first write of a run always mirrors (nothing has been written to throttle
 * against), so a crawl that dies seconds in still leaves the trace `onStartup`
 * needs to finalise its session.
 */
export async function writeCheckpoint(c: CrawlCheckpoint, force = false): Promise<boolean> {
  let ok = true;
  try {
    await chrome.storage.session.set({ [CHECKPOINT_KEY]: c });
  } catch {
    /* session quota (10 MB, not lifted by unlimitedStorage) or no extension
       context — the mirror below is the fallback; never throw into the engine.
       But DO report it: a failed write leaves the PREVIOUS checkpoint in place,
       so a later eviction resumes from a stale frontier and the crawler
       re-clicks buttons it already clicked on a live site. Silently swallowing
       that turned a recoverable condition into unexplained duplicate activity. */
    ok = false;
  }
  if (!force && c.at - lastMirrorAt < MIRROR_THROTTLE_MS) return ok;
  lastMirrorAt = c.at;
  try {
    await chrome.storage.local.set({ [CHECKPOINT_KEY]: c });
  } catch {
    /* ignore — the session copy is what resumes */
  }
  return ok;
}

/** Drop the checkpoint from both areas. Call when a run reaches a terminal state
 *  (or when starting a fresh one) so nothing can resurrect it. */
export async function clearCheckpoint(): Promise<void> {
  lastMirrorAt = 0;
  try {
    await chrome.storage.session.remove(CHECKPOINT_KEY);
  } catch {
    /* ignore */
  }
  try {
    await chrome.storage.local.remove(CHECKPOINT_KEY);
  } catch {
    /* ignore */
  }
}
