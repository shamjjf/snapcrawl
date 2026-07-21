import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";
import { errorFields, log } from "./logger";

// S3 object storage for screenshots (FR-BE-040/041/044, NFR-013). MinIO stands
// in for S3 locally (path-style + custom endpoint); real S3/CloudFront in prod.
const ENDPOINT = process.env.S3_ENDPOINT || undefined;
const REGION = process.env.S3_REGION ?? "us-east-1";
export const S3_BUCKET = process.env.S3_BUCKET ?? "snapcrawl";
const ACCESS_KEY = process.env.S3_ACCESS_KEY_ID ?? "minioadmin";
const SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin";
const FORCE_PATH_STYLE = (process.env.S3_FORCE_PATH_STYLE ?? "true") === "true";

/** Hard limits (NFR-013): uploads ≤ 15 MB, PUT presign ≤ 10 min, GET signed ≤ 1 h. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const PUT_TTL_SEC = 600;
export const GET_TTL_SEC = 3600;
/** The only content types a screenshot upload may be (NFR-013). Presign already
 *  restricts the PUT to these; completeCapture re-checks the STORED object, so a
 *  mismatch (a presign for png used to upload something else) is caught server-
 *  side rather than trusted. */
export const ALLOWED_UPLOAD_CONTENT_TYPES = ["image/png", "image/webp"] as const;

/** Is `contentType` an allowed screenshot type (NFR-013)? Tolerates a charset
 *  or other parameter suffix (`image/png; charset=binary`). Pure. */
export function isAllowedUploadContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const base = contentType.split(";")[0]!.trim().toLowerCase();
  return (ALLOWED_UPLOAD_CONTENT_TYPES as readonly string[]).includes(base);
}

export const s3 = new S3Client({
  region: REGION,
  endpoint: ENDPOINT,
  forcePathStyle: FORCE_PATH_STYLE,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
});

// ── Bucket bootstrap ────────────────────────────────────────────────────────
// The bucket is ensured by a background retrier rather than once at boot, so a
// storage backend that starts *after* the API still converges without a
// restart. Note what does NOT need this: presignPut/presignGet are offline URL
// signing, and the S3 client caches no negative state, so plain connectivity
// already self-heals. Only bucket EXISTENCE is genuinely boot-order sensitive.

export type EnsureOutcome = "ok" | "missing" | "unreachable" | "denied";

/** Classify an S3 error into an actionable outcome. Pure — no clock, no
 *  network. `missing` is the only outcome that warrants a CreateBucket. */
export function classifyBucketError(err: unknown): EnsureOutcome {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  const name = e?.name ?? "";
  // A create that lost a race with another instance is a success, not a failure.
  if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") return "ok";
  const status = e?.$metadata?.httpStatusCode;
  // No HTTP status ⇒ the request never reached a server (DNS/ECONNREFUSED).
  if (status === undefined) return "unreachable";
  if (status === 404 || name === "NotFound" || name === "NoSuchBucket") return "missing";
  if (status === 403 || name === "AccessDenied" || name === "Forbidden") return "denied";
  return "unreachable";
}

export const BUCKET_ENSURE_MIN_MS = 1_000;
export const BUCKET_ENSURE_MAX_MS = 60_000;

/** Full-jitter exponential backoff. Pure: `rand` is injected so a test can pin
 *  it. Attempt 0 ⇒ up to min, doubling per attempt, capped at max. */
export function nextEnsureDelay(
  attempt: number,
  rand: () => number = Math.random,
  minMs: number = BUCKET_ENSURE_MIN_MS,
  maxMs: number = BUCKET_ENSURE_MAX_MS,
): number {
  const ceiling = Math.min(maxMs, minMs * 2 ** attempt);
  return Math.round(ceiling * rand());
}

/** One ensure pass: does the bucket exist, and create it if not. */
export async function ensureBucketOnce(): Promise<EnsureOutcome> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
    return "ok";
  } catch (headErr) {
    const outcome = classifyBucketError(headErr);
    if (outcome !== "missing") return outcome;
    try {
      await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
      return "ok";
    } catch (createErr) {
      return classifyBucketError(createErr);
    }
  }
}

/** Create the bucket if it does not exist. Retained for the backfill script and
 *  any caller that wants a single synchronous attempt. */
export async function ensureBucket(): Promise<void> {
  const outcome = await ensureBucketOnce();
  if (outcome !== "ok") throw new Error(`bucket ensure failed: ${outcome}`);
}

/**
 * Keep retrying the bucket check in the background until it succeeds
 * (FR-BE-040/072). Deliberate deviations from startStaleSweeper's fixed
 * setInterval: the delay grows, so it self-reschedules; and it STOPS on
 * success, because polling a bucket that exists is pure waste.
 *
 * `denied` is terminal: prod IAM very likely withholds s3:CreateBucket (the
 * bucket is provisioned by IaC per NFR-013), and retrying a 403 forever would
 * spam logs and never succeed.
 *
 * In-process and single-instance, like the sweeper — a multi-instance
 * deployment is harmless here (CreateBucket races classify as "ok") but each
 * instance ensures independently (NFR-004).
 */
export function startBucketEnsurer(): { stop: () => void } {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let attempt = 0;

  const run = async (): Promise<void> => {
    if (stopped) return;
    const outcome = await ensureBucketOnce();
    if (stopped) return;
    if (outcome === "ok") {
      if (attempt > 0) {
        log.info("storage bucket ready", { bucket: S3_BUCKET, attempts: attempt + 1 });
      }
      return; // done — stop retrying.
    }
    if (outcome === "denied") {
      log.error("storage bucket access denied — not retrying", {
        bucket: S3_BUCKET,
        hint: "grant s3:HeadBucket/s3:CreateBucket, or pre-provision the bucket",
      });
      return;
    }
    const delay = nextEnsureDelay(attempt);
    // Log the FIRST failure only, then stay quiet: storage that never comes up
    // must not flood the log. The recovery is announced on success above.
    if (attempt === 0) {
      log.warn("storage bucket unavailable — retrying in the background", {
        bucket: S3_BUCKET,
        outcome,
      });
    }
    attempt += 1;
    schedule(delay);
  };

  const schedule = (delay: number): void => {
    timer = setTimeout(() => {
      void run().catch((err: unknown) => {
        log.warn("bucket ensure failed", { bucket: S3_BUCKET, ...errorFields(err) });
        schedule(nextEnsureDelay(attempt++));
      });
    }, delay);
    timer.unref?.();
  };

  schedule(0);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** Readiness probe input (FR-BE-072): can we reach the bucket? */
export async function s3Ready(): Promise<boolean> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
    return true;
  } catch {
    return false;
  }
}

/** Time-limited presigned PUT for a single server-chosen key + content type. */
export function presignPut(
  key: string,
  contentType: string,
  ttlSec: number = PUT_TTL_SEC,
): Promise<string> {
  const cmd = new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, ContentType: contentType });
  return getSignedUrl(s3, cmd, { expiresIn: ttlSec });
}

/** Short-lived presigned GET for authorised reads (FR-BE-044). */
export function presignGet(key: string, ttlSec: number = GET_TTL_SEC): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }), {
    expiresIn: ttlSec,
  });
}

/** Object metadata, or null if it does not exist. Used to verify uploads. */
export async function headObject(
  key: string,
): Promise<{ size: number; contentType?: string } | null> {
  try {
    const r = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return { size: r.ContentLength ?? 0, contentType: r.ContentType };
  } catch {
    return null;
  }
}

/** Download an object's bytes. Used server-side to render thumbnails
 *  (FR-BE-042) — never exposed to clients, who only ever get signed URLs. */
export async function getObjectBytes(key: string): Promise<Buffer> {
  const r = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  if (!r.Body) throw new Error(`empty body for ${key}`);
  return Buffer.from(await r.Body.transformToByteArray());
}

/** An object's body as a Node stream, for piping straight into a ZIP without
 *  buffering the whole image (FR-AP-042). The caller owns the stream. */
export async function getObjectStream(key: string): Promise<Readable> {
  const r = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  if (!r.Body) throw new Error(`empty body for ${key}`);
  return r.Body as Readable;
}

/**
 * Stream a body straight to S3 with multipart upload (FR-AP-042).
 *
 * A session ZIP can be gigabytes — 200 screenshots (maxScreens) at up to 15 MB
 * each — so it must never be assembled in memory the way `putObjectBytes` does.
 * `Upload` consumes the archiver stream and applies backpressure, so peak memory
 * is a few part-buffers regardless of the total size. Returns the stored size.
 */
export async function uploadStream(
  key: string,
  body: Readable,
  contentType: string,
): Promise<number> {
  const upload = new Upload({
    client: s3,
    params: { Bucket: S3_BUCKET, Key: key, Body: body, ContentType: contentType },
  });
  let bytes = 0;
  upload.on("httpUploadProgress", (p) => {
    if (typeof p.total === "number") bytes = p.total;
    else if (typeof p.loaded === "number") bytes = p.loaded;
  });
  await upload.done();
  return bytes;
}

/** Upload bytes from the server (thumbnails, FR-BE-042). Client uploads still
 *  go via presigned PUT — this never widens what the extension can do (C-05). */
export async function putObjectBytes(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: body, ContentType: contentType }),
  );
}

/** Best-effort delete (e.g. to drop an oversize upload). */
export async function deleteObject(key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  } catch {
    /* best effort */
  }
}

/** S3 caps one DeleteObjects call at 1000 keys. */
export const DELETE_BATCH_SIZE = 1000;

/** Split keys into DeleteObjects-sized chunks. Pure. */
export function chunkKeys(keys: string[], size = DELETE_BATCH_SIZE): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < keys.length; i += size) out.push(keys.slice(i, i + size));
  return out;
}

/**
 * Delete many objects, reporting which ones survived (FR-BE-025, FR-AP-043).
 *
 * Unlike `deleteObject`, this does NOT swallow failures — the cascade needs to
 * know, because the DB rows are the only remaining record of which objects
 * exist. Dropping the rows while the bytes survive would orphan them
 * permanently: nothing would reference the keys, so nothing could ever retry,
 * and a customer's screenshots would sit in the bucket after they deleted the
 * project. The caller keeps the rows and retries next sweep instead.
 *
 * Safe to retry: S3 reports deleting an already-absent key as a success.
 */
export async function deleteObjects(keys: string[]): Promise<{ failed: string[] }> {
  const failed: string[] = [];
  for (const chunk of chunkKeys(keys)) {
    try {
      const r = await s3.send(
        new DeleteObjectsCommand({
          Bucket: S3_BUCKET,
          Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      for (const e of r.Errors ?? []) if (e.Key) failed.push(e.Key);
    } catch (err) {
      // The whole request failed (storage down, credentials wrong) — every key
      // in the chunk is unconfirmed, so treat them all as survivors.
      log.warn("batch delete failed", { keys: chunk.length, ...errorFields(err) });
      failed.push(...chunk);
    }
  }
  return { failed };
}
