// SnapCrawl background service worker.
//
// Owns the pairing/project fetch (FR-EX-001/002): it holds host_permissions, so
// GET {backendUrl}/api/v1/ext/projects with a Bearer token bypasses CORS from
// here (the options/popup pages can't — the API's CORS only allows the web
// origin). C-05: the bearer token is never logged.
//
// Crawl orchestration lives here (not the popup) so a run survives the popup
// closing. C-03: MV3 kills this worker after ~30 s idle, so the engine
// checkpoints its state (FR-EX-080) and a woken worker rebuilds the run from it
// — see ensureResumed/resumeCrawl below, which every wake trigger funnels through.

import type { ExtMessage } from "../lib/messaging";
import {
  clearCheckpoint,
  getSessionNonce,
  readCheckpoint,
  readCheckpointMirror,
  resumeVeto,
  type CrawlCheckpoint,
} from "../lib/checkpoint";
import { updateSession } from "../lib/crawl-upload";
import {
  extProjectsUrl,
  getPairing,
  parseProjectsResponse,
  setCachedProjects,
  setPairing,
  normalizeBackendUrl,
  type ProjectsResult,
} from "../lib/pairing";
import {
  OfflineQueue,
  UploadClient,
  type QueueStore,
  type Transport,
  type UploadJob,
} from "../lib/upload";
import { dataUrlToBytes } from "../lib/zip";
import {
  CrawlController,
  shouldNavigateInPlace,
  type CrawlOptions,
  type CrawlProgress,
  type CrawlReason,
  type CrawlResult,
} from "../lib/crawl";
import { applyRunBadge, removeRunBadge } from "../content/crawl-inject";
import type { CrawlRunState, CrawlStatus } from "../lib/messaging";

chrome.runtime.onInstalled.addListener((details) => {
  console.info("[SnapCrawl] installed:", details.reason);
  // An install/update invalidates the injected content scripts and may have
  // changed the engine underneath a checkpoint the old one wrote, so a run must
  // never carry across it (CHECKPOINT_VERSION guards the checkpoint's shape; this
  // guards its behaviour). Ordering matters twice over: let any resume kicked off
  // at module eval settle first — otherwise it re-arms the alarm and rewrites the
  // checkpoint we just cleared — and check the mirror too, since storage.session
  // is dropped when the extension reloads and is usually already empty here.
  void (async () => {
    await ensureResumed().catch(() => {});
    if (crawl.controller) {
      crawl.controller.cancel(); // its finally finalises the session and clears up
      return;
    }
    const c = (await readCheckpoint()) ?? (await readCheckpointMirror());
    if (c) await abandonCheckpoint(c, `extension ${details.reason}`);
  })();
});

// Real HTTP transport for the upload client. host_permissions cover the backend
// origin and the S3/MinIO PUT origin, so these run CORS-free from the SW.
const fetchTransport: Transport = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body as BodyInit | undefined,
  });
  const text = await res.text().catch(() => "");
  return { status: res.status, ok: res.ok, text };
};

const QUEUE_KEY = "sc-upload-queue";
const queueStore: QueueStore = {
  get: async () => {
    const r = await chrome.storage.local.get(QUEUE_KEY);
    return Array.isArray(r[QUEUE_KEY]) ? (r[QUEUE_KEY] as UploadJob[]) : [];
  },
  set: async (jobs) => {
    await chrome.storage.local.set({ [QUEUE_KEY]: jobs });
  },
};

/** Build an upload client from the stored pairing, or null if unpaired. */
async function getUploadClient(): Promise<UploadClient | null> {
  const pairing = await getPairing();
  if (!pairing) return null;
  return new UploadClient(pairing.backendUrl, pairing.token, fetchTransport);
}

/** GET /ext/projects with the bearer token. Never logs the token (C-05). */
async function callProjects(backendUrl: string, token: string): Promise<ProjectsResult> {
  let res: Response;
  try {
    res = await fetch(extProjectsUrl(backendUrl), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
  } catch {
    return {
      ok: false,
      message: "Can't reach the backend. Check the URL and that the API is running.",
    };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body — parseProjectsResponse handles the empty case */
  }
  return parseProjectsResponse(res.status, body);
}

// ── Current-tab crawl runner (FR-EX-011) ──────────────────────────────────────
// The crawl runs HERE (not the popup) so it survives the popup closing, and it
// drives the user's OWN current tab in place — no separate window (product
// decision). C-01: captureVisibleTab needs the crawl tab to be the focused
// window's active tab, so we focus that window once here and the engine
// re-activates the tab before every capture.
//
// This object is worker memory: it dies with the worker (C-03). The durable copy
// is the checkpoint (FR-EX-080) — treat that, not this, as the source of truth
// for "is a crawl in flight".
const crawl = {
  controller: null as CrawlController | null,
  runState: "idle" as CrawlRunState,
  progress: null as CrawlProgress | null,
  result: null as CrawlResult | null,
};

// FR-EX-080 — the recovery trigger. To be precise about what this does: an alarm
// cannot keep a worker alive, and 30 s is the floor Chrome allows (anything
// shorter is clamped). A *running* crawl keeps itself alive through its own
// executeScript/tabs traffic; this alarm exists to WAKE the worker within ~30 s
// of an eviction so the run can be rebuilt — most importantly during a pause,
// where the engine makes no API calls at all and eviction is near-certain.
const RESUME_ALARM = "sc-crawl-resume";

async function armResumeAlarm(): Promise<void> {
  try {
    await chrome.alarms.create(RESUME_ALARM, { periodInMinutes: 0.5 });
  } catch {
    /* ignore */
  }
}

async function clearResumeAlarm(): Promise<void> {
  try {
    await chrome.alarms.clear(RESUME_ALARM);
  } catch {
    /* ignore */
  }
}

/** Give up on a run we can't rebuild: finalise the backend session honestly
 *  (partial results stay — the shots are in the capture sink) and drop the
 *  checkpoint so nothing retries it. FR-EX-083 / EC-019. */
async function abandonCheckpoint(c: CrawlCheckpoint | null, why: string): Promise<void> {
  if (c?.sessionId) {
    try {
      await updateSession(c.sessionId, { status: "failed", endReason: "error" });
    } catch {
      /* best effort — the heartbeat going stale is the backstop */
    }
  }
  await clearCheckpoint();
  await clearResumeAlarm();
  console.info(`[SnapCrawl] discarded an interrupted crawl (${why}).`);
}

function mapRunState(reason: CrawlReason): CrawlRunState {
  if (reason === "cancelled") return "cancelled";
  if (reason === "no-tab" || reason === "error") return "failed";
  return "completed";
}

async function waitTabComplete(tabId: number): Promise<void> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    let status: string | undefined;
    try {
      status = (await chrome.tabs.get(tabId)).status;
    } catch {
      return;
    }
    if (status === "complete") return;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Wire a controller into the worker's state and start it. Shared by a fresh
 *  start and a resume — the only difference is the `resume` checkpoint and
 *  whether the run state comes back paused. */
function runController(
  opts: CrawlOptions & { target: { tabId: number; windowId: number } },
  resume?: CrawlCheckpoint,
): void {
  const { tabId } = opts.target;
  const controller = new CrawlController();
  crawl.controller = controller;
  crawl.runState = resume?.paused ? "paused" : "running";
  void controller
    .run(
      opts,
      (p) => {
        crawl.progress = p;
      },
      resume,
    )
    .then((res) => {
      crawl.result = res;
      crawl.runState = mapRunState(res.reason);
    })
    .catch(() => {
      crawl.runState = "failed";
    })
    .finally(() => {
      crawl.controller = null;
      void clearResumeAlarm();
      chrome.scripting.executeScript({ target: { tabId }, func: removeRunBadge }).catch(() => {});
    });
}

async function startCrawl(
  startUrl: string,
  tab: { tabId: number; windowId: number },
  runOptions: Omit<CrawlOptions, "target">,
): Promise<{ ok: boolean; message?: string }> {
  // Settle any resume already in flight before reading crawl.controller. A woken
  // worker kicks one off at module load, and without this the check below could
  // read `null` while that resume is still awaiting — and we'd put a second
  // controller on the same tab.
  await ensureResumed();
  if (crawl.controller && (crawl.runState === "running" || crawl.runState === "paused")) {
    return { ok: false, message: "A crawl is already running." };
  }
  const { tabId, windowId } = tab;
  if (tabId == null || windowId == null) {
    return { ok: false, message: "No active tab to crawl." };
  }
  // Drop any previous run's checkpoint before this one writes its first: a corpse
  // left by a crawl that died without finalising would otherwise let the alarm
  // resume it *alongside* this run — two controllers driving one tab — and this
  // run's resetCrawlShots() would wipe the shots that corpse still counts on.
  await clearCheckpoint();
  crawl.runState = "running";
  crawl.progress = null;
  crawl.result = null;

  // Drive the user's CURRENT tab in place (no new window). Navigate it to the
  // start URL only if it isn't already there — normally the popup passes the
  // tab's own URL, so this is a no-op (FR-EX-010 already gated Start on scope).
  try {
    let current = "";
    try {
      current = (await chrome.tabs.get(tabId)).url ?? "";
    } catch {
      crawl.runState = "failed";
      return { ok: false, message: "No active tab to crawl." };
    }
    if (shouldNavigateInPlace(current, startUrl)) {
      await chrome.tabs.update(tabId, { url: startUrl });
      await waitTabComplete(tabId);
    }
    // C-01 — focus the crawl tab's window once so captureVisibleTab can see it.
    await chrome.windows.update(windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    crawl.runState = "failed";
    return { ok: false, message: "No active tab to crawl." };
  }
  console.info(
    "[SnapCrawl] crawling the current tab in place; re-activating it before each capture (C-01).",
  );

  await waitTabComplete(tabId);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: applyRunBadge });
  } catch {
    /* badge best-effort */
  }

  await armResumeAlarm(); // FR-EX-080 — recovery trigger for the rest of the run
  runController({ ...runOptions, target: { tabId, windowId } });
  return { ok: true };
}

// ── Resume after eviction (FR-EX-080 / C-03 / EC-012) ────────────────────────

/** Rebuild the run described by the checkpoint, or abandon it if any gate says
 *  we shouldn't. Never call directly — go through ensureResumed(). */
async function resumeCrawl(): Promise<void> {
  const c = await readCheckpoint(); // session only — never the local mirror
  if (!c) {
    await clearResumeAlarm(); // nothing in flight; stop waking up for nothing
    return;
  }

  const veto = resumeVeto(c, await getSessionNonce(), Date.now());
  if (veto) {
    await abandonCheckpoint(c, veto);
    return;
  }

  // The tab has to still be there. onTabRemoved is registered inside run(), so
  // during an eviction gap nothing is watching for EC-019 — this is where a tab
  // closed mid-gap is noticed.
  const target = c.opts.target!;
  try {
    await chrome.tabs.get(target.tabId);
  } catch {
    await abandonCheckpoint(c, "crawl tab is gone");
    return;
  }

  crawl.progress = c.progress;
  crawl.result = null;
  await armResumeAlarm();
  console.info(`[SnapCrawl] resuming an interrupted crawl (${c.queue.length} states queued).`);
  runController({ ...c.opts, target }, c);
}

// Exactly-once resume. Chrome runs a single, single-threaded worker instance, so
// a module-scope latch assigned SYNCHRONOUSLY (no await between the check and the
// set) is enough — two triggers firing back to back share the one promise instead
// of racing two controllers onto the same tab.
let resumeOnce: Promise<void> | null = null;

function ensureResumed(): Promise<void> {
  if (crawl.controller) return Promise.resolve();
  resumeOnce ??= resumeCrawl().finally(() => {
    resumeOnce = null;
  });
  return resumeOnce;
}

async function controlCrawl(action: "pause" | "resume" | "stop"): Promise<{ ok: boolean }> {
  // Settle any in-flight resume BEFORE reading crawl.controller. The Stop message
  // is often the very thing that wakes the worker, so without this the resume is
  // still parked on an await, we take the no-controller branch below and clear the
  // checkpoint — and then the resume finishes, re-arms the alarm and starts
  // clicking the tab again for the crawl the user just stopped.
  await ensureResumed();
  // Stop still has to work with no controller: the checkpoint would otherwise sit
  // there and let the alarm resurrect the run.
  if (!crawl.controller && action === "stop") {
    const c = await readCheckpoint();
    if (!c) return { ok: false };
    await clearCheckpoint();
    await clearResumeAlarm();
    if (c.sessionId) {
      try {
        await updateSession(c.sessionId, { status: "cancelled", endReason: "cancelled" });
      } catch {
        /* best effort */
      }
    }
    crawl.runState = "cancelled";
    return { ok: true };
  }
  if (!crawl.controller) return { ok: false };
  if (action === "pause") {
    crawl.controller.pause();
    crawl.runState = "paused";
  } else if (action === "resume") {
    crawl.controller.resume();
    crawl.runState = "running";
  } else {
    crawl.controller.cancel();
  }
  return { ok: true };
}

async function crawlStatus(): Promise<CrawlStatus> {
  // A poll is also a wake: without this, a popup opened during an eviction gap
  // would see runState "idle", show "ready" while a crawl is actually in flight,
  // and invite the user to start a second one.
  await ensureResumed();
  const r = crawl.result;
  // FR-EX-076 — the engine can auto-pause itself (a login/logout landing) without
  // a control message, so the SW's own runState wouldn't know. Reflect the
  // controller's live paused state so the popup shows Paused and offers Resume.
  const runState =
    crawl.controller && crawl.controller.isPaused && crawl.runState === "running"
      ? "paused"
      : crawl.runState;
  return {
    runState,
    progress: crawl.progress,
    result: r
      ? {
          captures: r.captures,
          states: r.states,
          pages: r.pages,
          edges: r.edges,
          abandoned: r.abandoned,
          uploaded: r.uploaded,
          unreachableRegions: r.unreachableRegions,
          reason: r.reason,
          error: r.error,
          sessionId: r.sessionId,
        }
      : null,
  };
}

async function handle(message: ExtMessage): Promise<unknown> {
  switch (message.type) {
    case "PING":
      return { type: "PONG", at: Date.now() };
    case "GET_STATUS":
      return { type: "STATUS", running: false };

    case "EXT_PAIR": {
      const backendUrl = normalizeBackendUrl(message.backendUrl);
      const result = await callProjects(backendUrl, message.token);
      if (result.ok) {
        await setPairing({ backendUrl, token: message.token });
        await setCachedProjects(result.projects);
      }
      return result;
    }

    case "EXT_GET_PROJECTS": {
      const pairing = await getPairing();
      if (!pairing) return { ok: false, message: "Not paired yet. Open Settings to pair." };
      const result = await callProjects(pairing.backendUrl, pairing.token);
      if (result.ok) await setCachedProjects(result.projects);
      return result;
    }

    // ── Session + upload (FR-EX-011/081) ──────────────────────────────────
    case "EXT_SESSION_CREATE": {
      const client = await getUploadClient();
      if (!client) return { ok: false, message: "Not paired." };
      const r = await client.createSession({ projectId: message.projectId, overrides: message.overrides });
      return r.ok ? { ok: true, sessionId: r.id } : { ok: false, message: r.message };
    }

    case "EXT_SESSION_UPDATE": {
      const client = await getUploadClient();
      if (!client) return { ok: false };
      return await client.updateSession(message.sessionId, message.update);
    }

    case "EXT_UPLOAD_CAPTURE": {
      const client = await getUploadClient();
      if (!client) return { ok: false, retryable: false, message: "Not paired." };
      const outcome = await client.uploadCapture({
        sessionId: message.sessionId,
        stateFingerprint: message.stateFingerprint,
        contentType: message.contentType,
        bytes: dataUrlToBytes(message.dataUrl),
        meta: message.meta,
      });
      if (!outcome.ok && outcome.retryable) {
        // Offline / transient — queue for later (EC-014). full ⇒ caller auto-pauses.
        const { queued, full } = await new OfflineQueue(queueStore).enqueue({
          sessionId: message.sessionId,
          stateFingerprint: message.stateFingerprint,
          contentType: message.contentType,
          dataUrl: message.dataUrl,
          meta: message.meta,
        });
        return { ...outcome, queued, full };
      }
      // On a success, opportunistically flush any backlog.
      if (outcome.ok) void new OfflineQueue(queueStore).drain(client);
      return { ...outcome, queued: false, full: false };
    }

    case "EXT_UPLOAD_EDGES": {
      const client = await getUploadClient();
      if (!client) return { ok: false, recorded: 0 };
      return await client.uploadEdges({ sessionId: message.sessionId, edges: message.edges });
    }

    // ── Current-tab crawl (FR-EX-011) ─────────────────────────────────────
    case "EXT_CRAWL_START":
      return await startCrawl(message.startUrl, message.tab, message.runOptions);
    case "EXT_CRAWL_CONTROL":
      return await controlCrawl(message.action);
    case "EXT_CRAWL_STATUS":
      return await crawlStatus();

    default:
      return undefined;
  }
}

// Async response requires returning `true` to keep the channel open.
chrome.runtime.onMessage.addListener((message: ExtMessage, _sender, sendResponse) => {
  handle(message)
    .then(sendResponse)
    .catch((e: unknown) =>
      sendResponse({ ok: false, message: e instanceof Error ? e.message : String(e) }),
    );
  return true;
});

// ── Wake triggers (FR-EX-080 / C-03) ─────────────────────────────────────────
// Listeners must be registered synchronously at the top level: a woken worker
// re-runs this module from scratch, and a listener added later can miss the very
// event that woke it.

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RESUME_ALARM) void ensureResumed();
});

// Browser restart. storage.session (and with it every live tab id) is gone, so
// there is nothing to resume — the mirror exists precisely so we can still close
// the books on the run instead of leaving its session `running` forever.
chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    const mirrored = await readCheckpointMirror();
    if (mirrored) await abandonCheckpoint(mirrored, "browser restarted");
  })();
});

// A worker woken by anything else at all (a message, a port) still gets a chance
// to notice an interrupted crawl. The alarm is the backstop when nothing else
// happens; the latch keeps this from double-starting alongside it.
void ensureResumed();
