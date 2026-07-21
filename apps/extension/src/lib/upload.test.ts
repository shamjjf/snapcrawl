import { describe, expect, it } from "vitest";
import type { CaptureMeta } from "@snapcrawl/shared";
import {
  backoffDelayMs,
  edgeKind,
  MAX_QUEUE,
  OfflineQueue,
  pngDimensions,
  sha256HexBytes,
  UploadClient,
  withRetry,
  type QueueStore,
  type Transport,
  type TransportResponse,
  type UploadJob,
} from "./upload";

const META: CaptureMeta = {
  url: "http://app.test/x",
  title: "X",
  depth: 0,
  viewport: { width: 800, height: 600 },
  fullPage: false,
  // FR-EX-090 — a run is one device, so every capture is tagged with its variant.
  variant: "desktop",
};

const NO_SLEEP = { sleep: async () => {}, rand: () => 0 };

function res(status: number, body?: unknown): TransportResponse {
  return { status, ok: status >= 200 && status < 300, text: body === undefined ? "" : JSON.stringify(body) };
}
function transport(handler: (req: { method: string; url: string }) => TransportResponse): Transport {
  return async (req) => handler(req);
}

describe("pure helpers (FR-EX-081)", () => {
  it("sha256HexBytes is deterministic 64-hex and input-sensitive", async () => {
    const a = await sha256HexBytes(new Uint8Array([1, 2, 3]));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256HexBytes(new Uint8Array([1, 2, 3]))).toBe(a);
    expect(await sha256HexBytes(new Uint8Array([1, 2, 4]))).not.toBe(a);
  });

  it("pngDimensions reads width/height from the IHDR chunk", () => {
    const bytes = new Uint8Array(24);
    // width 800 = 0x00000320 @ offset 16, height 600 = 0x00000258 @ offset 20
    bytes.set([0x00, 0x00, 0x03, 0x20], 16);
    bytes.set([0x00, 0x00, 0x02, 0x58], 20);
    expect(pngDimensions(bytes)).toEqual({ width: 800, height: 600 });
    expect(pngDimensions(new Uint8Array(10))).toEqual({ width: 0, height: 0 });
  });

  it("backoffDelayMs grows exponentially with bounded jitter", () => {
    expect(backoffDelayMs(1, 300, () => 0)).toBe(300);
    expect(backoffDelayMs(2, 300, () => 0)).toBe(600);
    expect(backoffDelayMs(3, 300, () => 0)).toBe(1200);
    const withJitter = backoffDelayMs(1, 300, () => 0.5);
    expect(withJitter).toBeGreaterThanOrEqual(300);
    expect(withJitter).toBeLessThan(600);
  });

  it("edgeKind classifies dead / substate / navigation", () => {
    expect(edgeKind("A", null, false)).toBe("dead");
    expect(edgeKind("A", "A", true)).toBe("dead");
    expect(edgeKind("A", "B", true)).toBe("substate");
    expect(edgeKind("A", "B", false)).toBe("navigation");
  });
});

describe("withRetry (FR-EX-081)", () => {
  it("succeeds after transient failures", async () => {
    let n = 0;
    const out = await withRetry(
      async () => {
        if (++n < 3) throw new Error("boom");
        return "ok";
      },
      { sleep: async () => {}, rand: () => 0 },
    );
    expect(out).toBe("ok");
    expect(n).toBe(3);
  });

  it("gives up after the attempt budget", async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new Error("nope");
        },
        { attempts: 3, sleep: async () => {}, rand: () => 0 },
      ),
    ).rejects.toThrow("nope");
    expect(n).toBe(3);
  });

  it("does not retry when the predicate says non-retryable", async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new Error("fatal");
        },
        { attempts: 3, sleep: async () => {}, rand: () => 0, retryable: () => false },
      ),
    ).rejects.toThrow("fatal");
    expect(n).toBe(1);
  });
});

describe("UploadClient.uploadCapture (FR-EX-081 / FR-BE-040/041)", () => {
  const bytes = new Uint8Array(24); // a stand-in PNG (dims read as 0×0, fine)

  it("skips the PUT when presign reports a duplicate (EC-015)", async () => {
    let putCalled = false;
    const t = transport((req) => {
      if (req.url.includes("/presign")) return res(200, { duplicate: true });
      if (req.method === "PUT") putCalled = true;
      return res(200);
    });
    const client = new UploadClient("http://api", "tok", t, NO_SLEEP);
    const out = await client.uploadCapture({ sessionId: "s", stateFingerprint: "fp", contentType: "image/png", bytes, meta: META });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.duplicate).toBe(true);
    expect(putCalled).toBe(false);
  });

  it("runs presign → PUT → complete on the happy path", async () => {
    const calls: string[] = [];
    const t = transport((req) => {
      calls.push(req.method + " " + req.url);
      if (req.url.includes("/presign")) return res(200, { duplicate: false, uploadUrl: "http://s3/put", key: "k" });
      if (req.method === "PUT") return res(200);
      if (req.url.includes("/complete")) return res(201, { id: "screen1" });
      return res(404);
    });
    const client = new UploadClient("http://api", "tok", t, NO_SLEEP);
    const out = await client.uploadCapture({ sessionId: "s", stateFingerprint: "fp", contentType: "image/png", bytes, meta: META });
    expect(out).toEqual({ ok: true, duplicate: false });
    expect(calls.some((c) => c.includes("/presign"))).toBe(true);
    expect(calls.some((c) => c.startsWith("PUT"))).toBe(true);
    expect(calls.some((c) => c.includes("/complete"))).toBe(true);
  });

  it("fails non-retryably on a 401 presign (bad token)", async () => {
    const t = transport(() => res(401, { code: "UNAUTHORIZED", message: "Invalid token." }));
    const client = new UploadClient("http://api", "tok", t, NO_SLEEP);
    const out = await client.uploadCapture({ sessionId: "s", stateFingerprint: "fp", contentType: "image/png", bytes, meta: META });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.retryable).toBe(false);
  });

  it("fails retryably when the S3 PUT keeps 5xx-ing", async () => {
    const t = transport((req) => {
      if (req.url.includes("/presign")) return res(200, { duplicate: false, uploadUrl: "http://s3/put", key: "k" });
      if (req.method === "PUT") return res(503);
      return res(200);
    });
    const client = new UploadClient("http://api", "tok", t, NO_SLEEP);
    const out = await client.uploadCapture({ sessionId: "s", stateFingerprint: "fp", contentType: "image/png", bytes, meta: META });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.retryable).toBe(true);
  });
});

describe("UploadClient.uploadLogs (FR-EX-082/084)", () => {
  it("POSTs the batch to /ext/logs and returns the recorded count", async () => {
    let posted: { method: string; url: string } | null = null;
    const t = transport((req) => {
      posted = req;
      return res(201, { recorded: 2 });
    });
    const client = new UploadClient("http://api", "tok", t, NO_SLEEP);
    const out = await client.uploadLogs({
      sessionId: "s",
      logs: [{ level: "error", event: "capture-failed" }, { level: "error", event: "click-failed" }],
    });
    expect(out).toEqual({ ok: true, recorded: 2 });
    expect(posted!.method).toBe("POST");
    expect(posted!.url).toContain("/api/v1/ext/logs");
  });

  it("reports failure (recorded 0) on a non-2xx that isn't retried away", async () => {
    const client = new UploadClient("http://api", "tok", transport(() => res(400)), NO_SLEEP);
    const out = await client.uploadLogs({ sessionId: "s", logs: [{ level: "error", event: "x" }] });
    expect(out).toEqual({ ok: false, recorded: 0 });
  });
});

describe("OfflineQueue (FR-EX-081 / EC-014)", () => {
  function memStore(): QueueStore {
    let jobs: UploadJob[] = [];
    return {
      get: async () => jobs.slice(),
      set: async (j) => {
        jobs = j.slice();
      },
    };
  }
  const job: UploadJob = {
    sessionId: "s",
    stateFingerprint: "fp",
    contentType: "image/png",
    dataUrl: "data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    meta: META,
  };

  it("enqueues up to MAX_QUEUE, then reports full (auto-pause)", async () => {
    const q = new OfflineQueue(memStore());
    for (let i = 0; i < MAX_QUEUE; i++) {
      const r = await q.enqueue(job);
      expect(r.queued).toBe(true);
    }
    expect(await q.size()).toBe(MAX_QUEUE);
    const overflow = await q.enqueue(job);
    expect(overflow).toEqual({ queued: false, full: true });
  });

  it("drain flushes when uploads succeed", async () => {
    const store = memStore();
    const q = new OfflineQueue(store);
    await q.enqueue(job);
    await q.enqueue(job);
    const client = new UploadClient(
      "http://api",
      "tok",
      transport((req) => {
        if (req.url.includes("/presign")) return res(200, { duplicate: false, uploadUrl: "http://s3/put", key: "k" });
        if (req.method === "PUT") return res(200);
        return res(201, { id: "x" });
      }),
      NO_SLEEP,
    );
    expect(await q.drain(client)).toBe(2);
    expect(await q.size()).toBe(0);
  });

  it("drain stops (keeps the queue) while still offline", async () => {
    const store = memStore();
    const q = new OfflineQueue(store);
    await q.enqueue(job);
    const client = new UploadClient("http://api", "tok", transport(() => res(503)), NO_SLEEP);
    expect(await q.drain(client)).toBe(0);
    expect(await q.size()).toBe(1);
  });
});
