import "dotenv/config";
import mongoose from "mongoose";
import { connectDb } from "../db";
import { getObjectBytes, headObject } from "../lib/s3";
import { flagNearDuplicate, generateThumbnail } from "../lib/thumbnails";
import { ScreenModel } from "../models/screen";
import { SessionModel } from "../models/session";
import { SessionLogModel } from "../models/sessionLog";

// One-off (and re-runnable) reconciler for data written before these features
// existed:  npm run backfill -w apps/api
//
//   1. sessions.logSeq   — seed the log-sequence allocator (FR-EX-084).
//   2. screens.thumbKey  — render the missing WebP thumbnails (FR-BE-042).
//   3. screens.bytes     — record stored object sizes (FR-AP-010).
//   4. screens.pHash     — perceptual hash + near-duplicate flag (FR-BE-043).
//
// Every step is idempotent, so this is also the permanent recovery path for
// thumbnails dropped by a crash or by the in-process concurrency ceiling.
//
// Step 1 is not optional and must run BEFORE the new /ext/logs code takes
// traffic: $inc on a missing field starts at `count`, so an un-seeded old
// session would restart at seq 0 and collide with its own existing rows —
// causing the very duplication the fix removes.

/** Seed `logSeq` from each session's existing high-water mark. `$max` makes it
 *  idempotent and monotonic: re-running can never walk a counter backwards
 *  (which would hand out already-used seq values). */
async function backfillLogSeq(): Promise<{ scanned: number; updated: number }> {
  const marks = await SessionLogModel.aggregate<{ _id: mongoose.Types.ObjectId; maxSeq: number }>([
    { $group: { _id: "$sessionId", maxSeq: { $max: "$seq" } } },
  ]);
  let updated = 0;
  for (const m of marks) {
    // timestamps:false — seeding a counter is not a domain edit, and without
    // this Mongoose rewrites updatedAt on every run, which both pollutes the
    // session's audit trail and makes modifiedCount useless as a real signal.
    const r = await SessionModel.updateOne(
      { _id: m._id },
      { $max: { logSeq: m.maxSeq + 1 } },
      { timestamps: false },
    );
    updated += r.modifiedCount;
  }
  return { scanned: marks.length, updated };
}

/** Render thumbnails for screens that have none. Sequential on purpose: this is
 *  a maintenance job that must not contend with live captures for memory or
 *  libvips threads. */
async function backfillThumbnails(): Promise<{ scanned: number; done: number; failed: number }> {
  // `$exists:false` OR null — covers rows written before the field existed and
  // rows explicitly set to null.
  const ids = await ScreenModel.find({
    $or: [{ thumbKey: { $exists: false } }, { thumbKey: null }],
  })
    .select("_id")
    .lean();
  let done = 0;
  let failed = 0;
  for (const { _id } of ids) {
    try {
      if (await generateThumbnail(String(_id))) done += 1;
    } catch (err) {
      failed += 1;
      // Report, never swallow: a screen that always fails to render (e.g. an
      // image too large even for bounded WebP) must be visible, not silent.
      // eslint-disable-next-line no-console
      console.warn(`  ! screen ${String(_id)}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { scanned: ids.length, done, failed };
}

/** Record sizes for screens the thumbnail pass didn't already cover (i.e. rows
 *  that already had a thumbKey). HeadObject is metadata-only — no download. */
async function backfillBytes(): Promise<{ scanned: number; updated: number; missing: number }> {
  const screens = await ScreenModel.find({
    $or: [{ bytes: { $exists: false } }, { bytes: null }],
  })
    .select("_id s3Key")
    .lean();
  let updated = 0;
  let missing = 0;
  for (const s of screens) {
    const head = await headObject(s.s3Key);
    if (!head) {
      missing += 1; // row survives but its object is gone — report, don't guess.
      continue;
    }
    await ScreenModel.updateOne({ _id: s._id }, { $set: { bytes: head.size } });
    updated += 1;
  }
  return { scanned: screens.length, updated, missing };
}

/** Hash screens that already have a thumbnail but no perceptual hash — rows
 *  written before FR-BE-043. Processed in _id order so the near-duplicate flag
 *  falls on the later capture of a pair and the first stays canonical, exactly
 *  as the live path does. Re-runnable: a screen that already has a pHash is
 *  skipped by the query. */
async function backfillPHash(): Promise<{ scanned: number; hashed: number; flagged: number; missing: number }> {
  const screens = await ScreenModel.find({
    $or: [{ pHash: { $exists: false } }, { pHash: null }],
  })
    .select("_id sessionId s3Key")
    .sort({ _id: 1 })
    .lean();
  let hashed = 0;
  let flagged = 0;
  let missing = 0;
  for (const s of screens) {
    let original: Buffer;
    try {
      original = await getObjectBytes(s.s3Key);
    } catch {
      missing += 1; // object gone — nothing to hash; row survives for later.
      continue;
    }
    const { pHash, isDuplicate } = await flagNearDuplicate(
      String(s._id),
      s.sessionId,
      s._id,
      original,
    );
    await ScreenModel.updateOne({ _id: s._id }, { $set: { pHash, isDuplicate } });
    hashed += 1;
    if (isDuplicate) flagged += 1;
  }
  return { scanned: screens.length, hashed, flagged, missing };
}

async function main(): Promise<void> {
  await connectDb();
  try {
    // eslint-disable-next-line no-console
    console.log("[backfill] 1/4 session log counters (FR-EX-084)…");
    const seq = await backfillLogSeq();
    // eslint-disable-next-line no-console
    console.log(`  sessions with logs: ${seq.scanned}, counters seeded: ${seq.updated}`);

    // eslint-disable-next-line no-console
    console.log("[backfill] 2/4 thumbnails (FR-BE-042)…");
    const thumbs = await backfillThumbnails();
    // eslint-disable-next-line no-console
    console.log(
      `  screens without a thumb: ${thumbs.scanned}, rendered: ${thumbs.done}, failed: ${thumbs.failed}`,
    );

    // eslint-disable-next-line no-console
    console.log("[backfill] 3/4 object sizes (FR-AP-010)…");
    const bytes = await backfillBytes();
    // eslint-disable-next-line no-console
    console.log(
      `  screens without a size: ${bytes.scanned}, recorded: ${bytes.updated}, object missing: ${bytes.missing}`,
    );

    // eslint-disable-next-line no-console
    console.log("[backfill] 4/4 perceptual hashes (FR-BE-043)…");
    const phash = await backfillPHash();
    // eslint-disable-next-line no-console
    console.log(
      `  screens without a hash: ${phash.scanned}, hashed: ${phash.hashed}, near-dupes flagged: ${phash.flagged}, object missing: ${phash.missing}`,
    );

    // eslint-disable-next-line no-console
    console.log("[backfill] done.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[backfill] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
