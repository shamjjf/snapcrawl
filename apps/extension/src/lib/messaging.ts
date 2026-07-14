// Typed messaging helpers. All extension messaging goes through here — never a
// raw untyped chrome.runtime.sendMessage payload (project convention).
//
// The pairing/project fetch (FR-EX-001/002) runs in the SERVICE WORKER, which
// holds host_permissions and so bypasses CORS; the popup/options call it through
// the typed helpers below.

import type { CaptureMeta, EdgeInput, SessionOverrides, SessionUpdate } from "@snapcrawl/shared";
import type { ProjectsResult } from "./pairing";
import type { UploadOutcome } from "./upload";
import type { CrawlOptions, CrawlProgress, CrawlReason } from "./crawl";

export type CrawlRunState =
  | "idle"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface CrawlStatus {
  runState: CrawlRunState;
  progress: CrawlProgress | null;
  result: {
    captures: number;
    states: number;
    pages: number;
    edges: number;
    uploaded: number;
    reason: CrawlReason;
    error?: string;
    sessionId: string | null;
  } | null;
}

export type ExtMessage =
  | { type: "PING" }
  | { type: "GET_STATUS" }
  | { type: "EXT_PAIR"; backendUrl: string; token: string }
  | { type: "EXT_GET_PROJECTS" }
  | { type: "EXT_SESSION_CREATE"; projectId: string; overrides?: SessionOverrides }
  | { type: "EXT_SESSION_UPDATE"; sessionId: string; update: SessionUpdate }
  | {
      type: "EXT_UPLOAD_CAPTURE";
      sessionId: string;
      stateFingerprint: string;
      contentType: "image/png" | "image/webp";
      dataUrl: string;
      meta: CaptureMeta;
    }
  | { type: "EXT_UPLOAD_EDGES"; sessionId: string; edges: EdgeInput[] }
  | {
      type: "EXT_CRAWL_START";
      startUrl: string;
      tab: { tabId: number; windowId: number };
      runOptions: Omit<CrawlOptions, "target">;
    }
  | { type: "EXT_CRAWL_CONTROL"; action: "pause" | "resume" | "stop" }
  | { type: "EXT_CRAWL_STATUS" };

export type ExtResponse =
  | { type: "PONG"; at: number }
  | { type: "STATUS"; running: boolean };

/** Per-capture upload result, plus offline-queue signals (FR-EX-081/EC-014). */
export type CaptureUploadResult = UploadOutcome & { queued?: boolean; full?: boolean };

/** Send a typed message to the background service worker and await its reply. */
export function sendMessage<R = ExtResponse>(message: ExtMessage): Promise<R> {
  return chrome.runtime.sendMessage(message) as Promise<R>;
}

/**
 * Pair: validate { backendUrl, token } by fetching /ext/projects from the SW,
 * persisting the pairing on success (FR-EX-001). Returns the projects or a clear
 * failure message.
 */
export function pairExtension(backendUrl: string, token: string): Promise<ProjectsResult> {
  return chrome.runtime.sendMessage({
    type: "EXT_PAIR",
    backendUrl,
    token,
  } satisfies ExtMessage) as Promise<ProjectsResult>;
}

/** Refresh the project list using the stored pairing (FR-EX-002). */
export function fetchProjectsViaWorker(): Promise<ProjectsResult> {
  return chrome.runtime.sendMessage({
    type: "EXT_GET_PROJECTS",
  } satisfies ExtMessage) as Promise<ProjectsResult>;
}

/** Create a backend session on crawl start (FR-EX-011). */
export function swCreateSession(
  projectId: string,
  overrides?: SessionOverrides,
): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }> {
  return chrome.runtime.sendMessage({
    type: "EXT_SESSION_CREATE",
    projectId,
    overrides,
  } satisfies ExtMessage) as Promise<{ ok: true; sessionId: string } | { ok: false; message: string }>;
}

/** Patch session status / stats / heartbeat (FR-EX-011). */
export function swUpdateSession(sessionId: string, update: SessionUpdate): Promise<{ ok: boolean }> {
  return chrome.runtime.sendMessage({
    type: "EXT_SESSION_UPDATE",
    sessionId,
    update,
  } satisfies ExtMessage) as Promise<{ ok: boolean }>;
}

/** Upload one capture via presign→PUT→complete in the SW (FR-EX-081). */
export function swUploadCapture(args: {
  sessionId: string;
  stateFingerprint: string;
  contentType: "image/png" | "image/webp";
  dataUrl: string;
  meta: CaptureMeta;
}): Promise<CaptureUploadResult> {
  return chrome.runtime.sendMessage({
    type: "EXT_UPLOAD_CAPTURE",
    ...args,
  } satisfies ExtMessage) as Promise<CaptureUploadResult>;
}

/** Upload a batch of edges (FR-EX-041 → FR-BE-045). */
export function swUploadEdges(
  sessionId: string,
  edges: EdgeInput[],
): Promise<{ ok: boolean; recorded: number }> {
  return chrome.runtime.sendMessage({
    type: "EXT_UPLOAD_EDGES",
    sessionId,
    edges,
  } satisfies ExtMessage) as Promise<{ ok: boolean; recorded: number }>;
}

/**
 * Start a crawl on the caller's CURRENT tab, run from the SW (FR-EX-011). The
 * popup passes the active tab it knows about — the SW drives that tab in place
 * (no new window). C-01: the SW focuses that window once and the engine keeps
 * the tab active around each capture.
 */
export function swStartCrawl(
  startUrl: string,
  tab: { tabId: number; windowId: number },
  runOptions: Omit<CrawlOptions, "target">,
): Promise<{ ok: boolean; message?: string }> {
  return chrome.runtime.sendMessage({
    type: "EXT_CRAWL_START",
    startUrl,
    tab,
    runOptions,
  } satisfies ExtMessage) as Promise<{ ok: boolean; message?: string }>;
}

/** Pause / resume / stop the running crawl (FR-EX-012). */
export function swControlCrawl(action: "pause" | "resume" | "stop"): Promise<{ ok: boolean }> {
  return chrome.runtime.sendMessage({
    type: "EXT_CRAWL_CONTROL",
    action,
  } satisfies ExtMessage) as Promise<{ ok: boolean }>;
}

/** Read the current crawl status (polled by the popup). */
export function swGetCrawlStatus(): Promise<CrawlStatus> {
  return chrome.runtime.sendMessage({
    type: "EXT_CRAWL_STATUS",
  } satisfies ExtMessage) as Promise<CrawlStatus>;
}
