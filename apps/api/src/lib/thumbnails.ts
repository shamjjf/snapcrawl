import sharp from "sharp";
import type { Types } from "mongoose";
import { ScreenModel } from "../models/screen";
import { errorFields, log } from "./logger";
import { closestWithinThreshold, computePHash, nearDuplicateThreshold } from "./phash";
import { getObjectBytes, putObjectBytes } from "./s3";

// WebP thumbnail generation for the gallery (FR-BE-042). The requirement says
// "asynchronously", and this API has no job queue, so the work is deferred to
// after the response and bounded in-process. Two properties make that safe
// rather than lossy:
//   1. `thumbKeyOf` falls back to the full image, so a missing thumb degrades
//      to today's shipped behaviour — never a broken image.
//   2. `{ thumbKey: null }` in Mongo IS the durable backlog, so the backfill
//      script is a permanent reconciler, not just a one-off migration.
// Single-instance, like the stale-session sweeper (NFR-004).

/** Max thumbnail width (FR-BE-042: "max 400 px wide"). */
export const THUMB_WIDTH = 400;
/** WebP is well past diminishing returns by ~80 for UI screenshots — measurably
 *  indistinguishable at gallery size, at a fraction of the bytes. */
export const THUMB_QUALITY = 80;
export const THUMB_CONTENT_TYPE = "image/webp";
/** WebP cannot exceed 16383px on a side. A full-page scroll-and-stitch (C-02)
 *  can be far taller, so bound the height too or sharp throws on the tallest
 *  captures — exactly the ones a gallery most wants a thumbnail for. */
const WEBP_MAX_SIDE = 16383;

/** How many thumbnails may render at once. libvips has its own threadpool, and
 *  the real cost is DECODED pixels, not file size: a 1280x6000 stitch is a
 *  ~112 KB PNG but ~23 MB of raw RGB. */
const MAX_CONCURRENT = 3;

/** Render a thumbnail. Pure bytes→bytes: no S3, no DB, no clock — the seam the
 *  unit tests drive. */
export async function renderThumbnail(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .resize({
      width: THUMB_WIDTH,
      height: WEBP_MAX_SIDE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: THUMB_QUALITY })
    .toBuffer();
}

/** Thumbnail object key derived from the full-image key: same path, `.webp`
 *  suffix. Pure. */
export function thumbKeyFor(s3Key: string): string {
  return `${s3Key.replace(/\.[^./]+$/, "")}.thumb.webp`;
}

/**
 * Compute a screen's perceptual hash and flag it if it near-duplicates an
 * earlier state in the same session (FR-BE-043).
 *
 * Done here rather than in its own worker because this function already holds
 * the decoded original in memory — a separate pass would re-download every
 * screenshot purely to hash it. Pure-ish: takes the loaded bytes, owns only its
 * own row's pHash/isDuplicate writes.
 *
 * "Earlier" = a lower _id in the same session that already has a pHash, so of a
 * near-duplicate PAIR exactly one is flagged and the first-captured stays
 * canonical (`{ $lt: screen._id }`). Two captures hashed concurrently could both
 * miss each other (neither has written its pHash when the other queries); the
 * backfill's re-run reconciles that rare case. contentHash exact-dupes never
 * reach here — presign drops them before an upload (FR-BE-040).
 */
export async function flagNearDuplicate(
  screenId: string,
  sessionId: Types.ObjectId,
  screenObjectId: Types.ObjectId,
  original: Buffer,
  variant: "desktop" | "mobile" = "desktop",
): Promise<{ pHash: string; isDuplicate: boolean }> {
  const pHash = await computePHash(original);
  const threshold = nearDuplicateThreshold();

  // FR-EX-090 — compare like with like. A 1170x2532 phone shot and a 1366x900
  // desktop shot of the SAME state are not near-duplicates of each other, and
  // letting them into one pool would flag every mobile row against its own twin.
  const variantFilter: Record<string, unknown> =
    variant === "mobile" ? { variant: "mobile" } : { variant: { $ne: "mobile" } };
  const priors = await ScreenModel.find({
    sessionId,
    ...variantFilter,
    _id: { $lt: screenObjectId },
    pHash: { $exists: true, $ne: null },
  })
    .select("_id pHash")
    .lean();

  const match = closestWithinThreshold(
    pHash,
    priors.map((p) => ({ id: String(p._id), pHash: p.pHash as string })),
    threshold,
  );
  if (match) {
    log.info("near-duplicate screen flagged", { screenId, of: match.id, distance: match.distance });
  }
  return { pHash, isDuplicate: match !== null };
}

/** Generate + store the thumbnail for one screen, recording its key and size,
 *  plus its perceptual hash and near-duplicate flag (FR-BE-042/043).
 *  Idempotent: a screen that already has a thumbKey is skipped. */
export async function generateThumbnail(screenId: string): Promise<boolean> {
  const screen = await ScreenModel.findById(screenId);
  if (!screen || screen.thumbKey) return false;

  const original = await getObjectBytes(screen.s3Key);
  const thumb = await renderThumbnail(original);
  const key = thumbKeyFor(screen.s3Key);
  await putObjectBytes(key, thumb, THUMB_CONTENT_TYPE);

  // Perceptual hash + near-duplicate flag while the original is decoded in
  // memory (FR-BE-043). A hash failure must not lose the thumbnail we just
  // stored — fall back to no flag rather than failing the whole render.
  let phash: { pHash: string; isDuplicate: boolean } | null = null;
  try {
    phash = await flagNearDuplicate(
      screenId,
      screen.sessionId,
      screen._id,
      original,
      screen.variant === "mobile" ? "mobile" : "desktop",
    );
  } catch (err) {
    log.warn("perceptual hash failed", { screenId, ...errorFields(err) });
  }

  // Record the original's size too while we have it — the dashboard's storage
  // KPI needs both halves (FR-AP-010).
  await ScreenModel.updateOne(
    { _id: screen._id },
    {
      $set: {
        thumbKey: key,
        thumbBytes: thumb.length,
        bytes: original.length,
        ...(phash ? { pHash: phash.pHash, isDuplicate: phash.isDuplicate } : {}),
      },
    },
  );
  return true;
}

/** Ceiling on one render attempt. Load-bearing for the concurrency counter, not
 *  just for latency: an S3 endpoint that accepts a connection and never replies
 *  leaves the SDK request pending indefinitely (nothing errors, so its retry
 *  policy never fires). Without a deadline, MAX_CONCURRENT such hangs would pin
 *  the counter at its ceiling and disable thumbnails for the whole process. */
export const THUMB_TIMEOUT_MS = 30_000;

/** Reject if `p` has not settled within `ms`. The underlying request is not
 *  cancelled — this bounds our bookkeeping, not the socket — so the screen just
 *  stays in the `{thumbKey:null}` backlog for the backfill to reconcile. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    p.then(resolve, reject).finally(() => {
      clearTimeout(timer);
    });
  });
}

let inFlight = 0;

/** Test-only view of the semaphore. */
export function inFlightCount(): number {
  return inFlight;
}

/**
 * Queue a thumbnail render without blocking the caller's response (FR-BE-042).
 *
 * `void p.catch(handler)` is deliberate, and is NOT a floating promise: a
 * floating promise is one whose rejection is unhandled. This is the same
 * fire-and-forget idiom the stale-session sweeper already uses.
 *
 * Over the concurrency ceiling we simply skip: the screen keeps `thumbKey:
 * null`, so it stays in the durable backlog for the backfill rather than
 * queueing unbounded buffers in memory.
 */
export function queueThumbnail(screenId: string): void {
  if (inFlight >= MAX_CONCURRENT) return;
  inFlight += 1;
  void withTimeout(generateThumbnail(screenId), THUMB_TIMEOUT_MS, `thumbnail ${screenId}`)
    .catch((err: unknown) => {
      // Must be logged, not swallowed: a screen whose render always fails (e.g.
      // an image too large even for bounded WebP) would otherwise silently
      // never get a thumbnail.
      log.warn("thumbnail failed", { screenId, ...errorFields(err) });
    })
    .finally(() => {
      inFlight -= 1;
    });
}
