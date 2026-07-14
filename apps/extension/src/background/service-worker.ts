// SnapCrawl background service worker.
//
// Owns the pairing/project fetch (FR-EX-001/002): it holds host_permissions, so
// GET {backendUrl}/api/v1/ext/projects with a Bearer token bypasses CORS from
// here (the options/popup pages can't — the API's CORS only allows the web
// origin). C-05: the bearer token is never logged.
//
// C-03: crawl orchestration is NOT yet here (it runs in the popup for Phase 0);
// moving it here with chrome.storage checkpoints is FR-EX-080/060, a later slice.

import type { ExtMessage } from "../lib/messaging";
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
// re-activates the tab before every capture. Checkpoint/resume across SW
// eviction is a later slice — an active crawl keeps the SW alive.
const crawl = {
  controller: null as CrawlController | null,
  runState: "idle" as CrawlRunState,
  progress: null as CrawlProgress | null,
  result: null as CrawlResult | null,
};

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

async function startCrawl(
  startUrl: string,
  tab: { tabId: number; windowId: number },
  runOptions: Omit<CrawlOptions, "target">,
): Promise<{ ok: boolean; message?: string }> {
  if (crawl.controller && (crawl.runState === "running" || crawl.runState === "paused")) {
    return { ok: false, message: "A crawl is already running." };
  }
  const { tabId, windowId } = tab;
  if (tabId == null || windowId == null) {
    return { ok: false, message: "No active tab to crawl." };
  }
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

  const controller = new CrawlController();
  crawl.controller = controller;
  void controller
    .run({ ...runOptions, target: { tabId, windowId } }, (p) => {
      crawl.progress = p;
    })
    .then((res) => {
      crawl.result = res;
      crawl.runState = mapRunState(res.reason);
    })
    .catch(() => {
      crawl.runState = "failed";
    })
    .finally(() => {
      crawl.controller = null;
      chrome.scripting.executeScript({ target: { tabId }, func: removeRunBadge }).catch(() => {});
    });
  return { ok: true };
}

function controlCrawl(action: "pause" | "resume" | "stop"): { ok: boolean } {
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

function crawlStatus(): CrawlStatus {
  const r = crawl.result;
  return {
    runState: crawl.runState,
    progress: crawl.progress,
    result: r
      ? {
          captures: r.captures,
          states: r.states,
          pages: r.pages,
          edges: r.edges,
          uploaded: r.uploaded,
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
      return controlCrawl(message.action);
    case "EXT_CRAWL_STATUS":
      return crawlStatus();

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
