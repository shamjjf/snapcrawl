// Direct upload operations for the crawl loop (FR-EX-011/081).
//
// The crawl runs INSIDE the service worker (to drive the user's current tab), so
// it can't reach the SW's message handlers via chrome.runtime.sendMessage — a
// context can't message itself. These call the UploadClient /
// OfflineQueue directly. The SW's EXT_UPLOAD_* message handlers delegate here
// too, so there's a single implementation.

import type {
  CaptureMeta,
  EdgeInput,
  SessionLogInput,
  SessionOverrides,
  SessionUpdate,
} from "@snapcrawl/shared";
import { getPairing } from "./pairing";
import {
  OfflineQueue,
  UploadClient,
  type QueueStore,
  type Transport,
  type UploadJob,
} from "./upload";
import { dataUrlToBytes } from "./zip";

/** FR-EX-012 — a run-scoped abort signal so Stop interrupts an in-flight upload.
 *
 *  run()'s `raceCancel` wraps sleep/exec/execMain, but NOT uploadCapture — so a
 *  fetch that never settles (VPN drop, captive portal, black-holed connection)
 *  left Stop dead indefinitely. maxDurationMin was the de-facto backstop and it
 *  never fired either: the duration check only runs at overLimit() call sites
 *  inside the loop. With the limits gone, Stop is the only termination there is,
 *  so the transport has to be interruptible. */
let runAbort: AbortSignal | null = null;
export function setRunAbortSignal(signal: AbortSignal | null): void {
  runAbort = signal;
}

/** Ceiling on a single request. Generous — a full-page PNG on a slow link is
 *  legitimately slow — but finite, so a wedged socket can't outlive the run. */
const REQUEST_TIMEOUT_MS = 20_000;

const transport: Transport = async (req) => {
  const signals: AbortSignal[] = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
  if (runAbort) signals.push(runAbort);
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body as BodyInit | undefined,
    signal: AbortSignal.any(signals),
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

async function makeClient(): Promise<UploadClient | null> {
  const p = await getPairing();
  return p ? new UploadClient(p.backendUrl, p.token, transport) : null;
}

export async function createSession(
  projectId: string,
  overrides?: SessionOverrides,
): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }> {
  const c = await makeClient();
  if (!c) return { ok: false, message: "Not paired." };
  const r = await c.createSession({ projectId, overrides });
  return r.ok ? { ok: true, sessionId: r.id } : { ok: false, message: r.message };
}

export async function updateSession(
  sessionId: string,
  update: SessionUpdate,
): Promise<{ ok: boolean }> {
  const c = await makeClient();
  if (!c) return { ok: false };
  return c.updateSession(sessionId, update);
}

export interface CaptureUploadResult {
  ok: boolean;
  duplicate?: boolean;
  retryable?: boolean;
  message?: string;
  queued?: boolean;
  full?: boolean;
}

export async function uploadCapture(args: {
  sessionId: string;
  stateFingerprint: string;
  contentType: "image/png" | "image/webp";
  dataUrl: string;
  meta: CaptureMeta;
}): Promise<CaptureUploadResult> {
  const c = await makeClient();
  if (!c) return { ok: false, retryable: false, message: "Not paired.", queued: false, full: false };
  const outcome = await c.uploadCapture({
    sessionId: args.sessionId,
    stateFingerprint: args.stateFingerprint,
    contentType: args.contentType,
    bytes: dataUrlToBytes(args.dataUrl),
    meta: args.meta,
  });
  if (!outcome.ok && outcome.retryable) {
    const { queued, full } = await new OfflineQueue(queueStore).enqueue({
      sessionId: args.sessionId,
      stateFingerprint: args.stateFingerprint,
      contentType: args.contentType,
      dataUrl: args.dataUrl,
      meta: args.meta,
    });
    return { ...outcome, queued, full };
  }
  if (outcome.ok) void new OfflineQueue(queueStore).drain(c);
  return { ...outcome, queued: false, full: false };
}

export async function uploadEdges(
  sessionId: string,
  edges: EdgeInput[],
): Promise<{ ok: boolean; recorded: number }> {
  const c = await makeClient();
  if (!c) return { ok: false, recorded: 0 };
  return c.uploadEdges({ sessionId, edges });
}

/** Batched session-log (error) upload (FR-EX-082/084). Best-effort like edges. */
export async function uploadLogs(
  sessionId: string,
  logs: SessionLogInput[],
): Promise<{ ok: boolean; recorded: number }> {
  const c = await makeClient();
  if (!c) return { ok: false, recorded: 0 };
  return c.uploadLogs({ sessionId, logs });
}
