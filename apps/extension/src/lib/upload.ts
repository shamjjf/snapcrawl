// Upload client (FR-EX-011/081) — session lifecycle + presign→PUT→complete +
// edge batches against the backend's /ext API. Built to be unit-testable: all
// I/O goes through an injected `Transport`, so the network logic (retry with
// exponential backoff + jitter, dedupe-skip, offline queue) is exercised with a
// mock. The service worker wires a real fetch transport + chrome.storage queue.

import type {
  CaptureComplete,
  CaptureMeta,
  EdgeBatch,
  EdgeKind,
  PresignRequest,
  PresignResponse,
  SessionCreate,
  SessionLogBatch,
  SessionUpdate,
} from "@snapcrawl/shared";
import { dataUrlToBytes } from "./zip";

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** SHA-256 of raw bytes → lowercase hex. Used as the capture contentHash (FR-BE-040). */
export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Read a PNG's pixel dimensions from its IHDR chunk (width@16, height@20, BE). */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 24) return { width: 0, height: 0 };
  const u32 = (o: number): number =>
    ((bytes[o]! << 24) | (bytes[o + 1]! << 16) | (bytes[o + 2]! << 8) | bytes[o + 3]!) >>> 0;
  return { width: u32(16), height: u32(20) };
}

/** Exponential backoff with additive jitter (FR-EX-081). `rand` injectable for tests. */
export function backoffDelayMs(attempt: number, baseMs = 300, rand: () => number = Math.random): number {
  const exp = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  return exp + Math.floor(rand() * baseMs);
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
  retryable?: (e: unknown) => boolean;
}

/** Retry `fn` up to `attempts` times, backing off between retryable failures. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const retryable = opts.retryable ?? (() => true);
  let lastErr: unknown;
  for (let a = 1; a <= attempts; a++) {
    try {
      return await fn(a);
    } catch (e) {
      lastErr = e;
      if (a >= attempts || !retryable(e)) break;
      await sleep(backoffDelayMs(a, opts.baseMs, opts.rand));
    }
  }
  throw lastErr;
}

/** Classify a recorded edge for /ext/edges (FR-EX-041 → FR-BE-045). Pure. */
export function edgeKind(fromFp: string, toFp: string | null | undefined, sameUrl: boolean): EdgeKind {
  if (!toFp || toFp === fromFp) return "dead";
  return sameUrl ? "substate" : "navigation";
}

// ── Transport ───────────────────────────────────────────────────────────────

export interface TransportResponse {
  status: number;
  ok: boolean;
  text: string;
}
export interface TransportRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

/** Marks a failure the retry loop should retry (network error, 429, or 5xx). */
class RetryableError extends Error {}
const isRetryable = (e: unknown): boolean => e instanceof RetryableError;
const retryableStatus = (status: number): boolean => status === 429 || status >= 500;

export type UploadOutcome =
  | { ok: true; duplicate: boolean }
  | { ok: false; retryable: boolean; message: string };

export interface CaptureUpload {
  sessionId: string;
  stateFingerprint: string;
  contentType: "image/png" | "image/webp";
  bytes: Uint8Array;
  meta: CaptureMeta;
}

// ── Upload client ─────────────────────────────────────────────────────────────

export class UploadClient {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rand: () => number;

  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly transport: Transport,
    opts: { sleep?: (ms: number) => Promise<void>; rand?: () => number } = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.rand = opts.rand ?? Math.random;
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  /** JSON request that THROWS RetryableError on network/429/5xx (so withRetry retries). */
  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: unknown }> {
    let res: TransportResponse;
    try {
      res = await this.transport({
        method,
        url: this.base + path,
        headers: this.authHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new RetryableError("network");
    }
    if (retryableStatus(res.status)) throw new RetryableError(`http ${res.status}`);
    let data: unknown = null;
    try {
      data = res.text ? JSON.parse(res.text) : null;
    } catch {
      /* non-JSON body */
    }
    return { status: res.status, data };
  }

  private retry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, { sleep: this.sleep, rand: this.rand, retryable: isRetryable });
  }

  private msgOf(data: unknown, fallback: string): string {
    return (data as { message?: string })?.message ?? fallback;
  }

  async createSession(
    input: SessionCreate,
  ): Promise<{ ok: true; id: string } | { ok: false; status?: number; message: string }> {
    try {
      const { status, data } = await this.retry(() => this.request("POST", "/api/v1/ext/sessions", input));
      if (status === 201 || status === 200) {
        const id = (data as { id?: string; _id?: string })?.id ?? (data as { _id?: string })?._id;
        return id ? { ok: true, id } : { ok: false, status, message: "Session response missing id." };
      }
      return { ok: false, status, message: this.msgOf(data, `Session create failed (${status}).`) };
    } catch {
      return { ok: false, message: "Can't reach the backend to create a session." };
    }
  }

  async updateSession(id: string, update: SessionUpdate): Promise<{ ok: boolean; status?: number }> {
    try {
      const { status } = await this.retry(() =>
        this.request("PATCH", `/api/v1/ext/sessions/${id}`, update),
      );
      return { ok: status >= 200 && status < 300, status };
    } catch {
      return { ok: false };
    }
  }

  private async putBytes(url: string, contentType: string, bytes: Uint8Array): Promise<void> {
    await this.retry(async () => {
      let res: TransportResponse;
      try {
        res = await this.transport({ method: "PUT", url, headers: { "Content-Type": contentType }, body: bytes });
      } catch {
        throw new RetryableError("network");
      }
      if (retryableStatus(res.status)) throw new RetryableError(`http ${res.status}`);
      if (res.status < 200 || res.status >= 300) throw new Error(`PUT failed (${res.status}).`);
    });
  }

  /** presign → (skip if duplicate) → PUT to S3 → complete (FR-EX-081 / FR-BE-040/041). */
  async uploadCapture(args: CaptureUpload): Promise<UploadOutcome> {
    const contentHash = await sha256HexBytes(args.bytes);
    const presignReq: PresignRequest = {
      sessionId: args.sessionId,
      stateFingerprint: args.stateFingerprint,
      contentHash,
      contentType: args.contentType,
      meta: args.meta,
    };

    let presign: { status: number; data: unknown };
    try {
      presign = await this.retry(() => this.request("POST", "/api/v1/ext/captures/presign", presignReq));
    } catch {
      return { ok: false, retryable: true, message: "presign network error" };
    }
    if (presign.status !== 200) {
      return { ok: false, retryable: false, message: this.msgOf(presign.data, `presign failed (${presign.status})`) };
    }
    const pr = presign.data as PresignResponse;
    if (pr.duplicate) return { ok: true, duplicate: true }; // EC-015 — skip upload
    if (!pr.uploadUrl || !pr.key) return { ok: false, retryable: false, message: "presign missing upload URL" };

    try {
      await this.putBytes(pr.uploadUrl, args.contentType, args.bytes);
    } catch (e) {
      return { ok: false, retryable: isRetryable(e), message: "S3 PUT failed" };
    }

    const dims = pngDimensions(args.bytes);
    const completeReq: CaptureComplete = {
      sessionId: args.sessionId,
      stateFingerprint: args.stateFingerprint,
      contentHash,
      key: pr.key,
      width: dims.width,
      height: dims.height,
      meta: args.meta,
    };
    let comp: { status: number; data: unknown };
    try {
      comp = await this.retry(() => this.request("POST", "/api/v1/ext/captures/complete", completeReq));
    } catch {
      return { ok: false, retryable: true, message: "complete network error" };
    }
    if (comp.status === 200 || comp.status === 201) return { ok: true, duplicate: false };
    return { ok: false, retryable: false, message: this.msgOf(comp.data, `complete failed (${comp.status})`) };
  }

  async uploadEdges(batch: EdgeBatch): Promise<{ ok: boolean; recorded: number }> {
    try {
      const { status, data } = await this.retry(() => this.request("POST", "/api/v1/ext/edges", batch));
      if (status === 200 || status === 201) {
        return { ok: true, recorded: (data as { recorded?: number })?.recorded ?? 0 };
      }
      return { ok: false, recorded: 0 };
    } catch {
      return { ok: false, recorded: 0 };
    }
  }

  /** Batched session-log (error) upload for the panel's log (FR-EX-082/084). */
  async uploadLogs(batch: SessionLogBatch): Promise<{ ok: boolean; recorded: number }> {
    try {
      const { status, data } = await this.retry(() => this.request("POST", "/api/v1/ext/logs", batch));
      if (status === 200 || status === 201) {
        return { ok: true, recorded: (data as { recorded?: number })?.recorded ?? 0 };
      }
      return { ok: false, recorded: 0 };
    } catch {
      return { ok: false, recorded: 0 };
    }
  }
}

// ── Offline queue (FR-EX-081 / EC-014) ────────────────────────────────────────

/** A capture deferred while offline — stored as base64 so it survives JSON. */
export interface UploadJob {
  sessionId: string;
  stateFingerprint: string;
  contentType: "image/png" | "image/webp";
  dataUrl: string;
  meta: CaptureMeta;
}

export interface QueueStore {
  get(): Promise<UploadJob[]>;
  set(jobs: UploadJob[]): Promise<void>;
}

export const MAX_QUEUE = 50; // EC-014 — beyond this the crawl auto-pauses.

export class OfflineQueue {
  constructor(private readonly store: QueueStore) {}

  async size(): Promise<number> {
    return (await this.store.get()).length;
  }

  /** Append a job unless full. `full: true` ⇒ caller should auto-pause the crawl. */
  async enqueue(job: UploadJob): Promise<{ queued: boolean; full: boolean }> {
    const jobs = await this.store.get();
    if (jobs.length >= MAX_QUEUE) return { queued: false, full: true };
    jobs.push(job);
    await this.store.set(jobs);
    return { queued: true, full: jobs.length >= MAX_QUEUE };
  }

  /** Flush FIFO via `client`; stops at the first still-retryable failure. Returns count flushed. */
  async drain(client: UploadClient): Promise<number> {
    let jobs = await this.store.get();
    let flushed = 0;
    while (jobs.length > 0) {
      const job = jobs[0]!;
      const outcome = await client.uploadCapture({
        sessionId: job.sessionId,
        stateFingerprint: job.stateFingerprint,
        contentType: job.contentType,
        bytes: dataUrlToBytes(job.dataUrl),
        meta: job.meta,
      });
      if (!outcome.ok && outcome.retryable) break; // still offline — keep the rest
      jobs = jobs.slice(1);
      await this.store.set(jobs);
      flushed++;
    }
    return flushed;
  }
}
