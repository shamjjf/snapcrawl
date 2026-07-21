import { PassThrough } from "node:stream";
import archiver from "archiver";
import type { SessionExport } from "@snapcrawl/shared";
import { errorFields, log } from "../../lib/logger";
import { getObjectStream, presignGet, uploadStream } from "../../lib/s3";
import { ExportJobModel, type ExportJobDoc } from "../../models/exportJob";
import { ScreenModel } from "../../models/screen";

// Session ZIP export (FR-AP-042). Streams every screenshot in a session into a
// single ZIP in S3, asynchronously — the job row is the notification channel
// (see sessionExportSchema). In-process like the thumbnail and purge workers;
// a real deployment would move this to a queue (NFR-004), and nothing about the
// job-row contract would change if it did.

/** Bounded concurrent builds. A build streams N images through this process, so
 *  unlike a cheap CRUD call it must not fan out without limit. */
const MAX_CONCURRENT = 2;
let inFlight = 0;

export function exportInFlightCount(): number {
  return inFlight;
}

/** Object key for a session's export ZIP. Server-chosen, like screen keys. */
export function exportKey(sessionId: string, exportId: string): string {
  return `exports/${sessionId}/${exportId}.zip`;
}

/**
 * A filename for one screenshot inside the ZIP. Ordered and unique.
 *
 * Prefixed with a zero-padded capture index so the archive lists in capture
 * order in any unzip tool, and suffixed with the screen id so two states of the
 * same URL cannot collide on one name. The URL fragment is purely for a human
 * reading the file list — sanitised hard, because it lands on a real filesystem
 * when extracted (a `/` or `..` here would be a path-traversal on unzip).
 */
export function entryName(index: number, screenId: string, url: string, ext: string): string {
  const seq = String(index + 1).padStart(4, "0");
  const slug =
    url
      .replace(/^https?:\/\//, "")
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "page";
  return `${seq}-${slug}-${screenId}.${ext}`;
}

/** File extension for a stored screenshot, from its key. Pure. */
function extOf(s3Key: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(s3Key);
  return m ? m[1]!.toLowerCase() : "png";
}

/** Serialize an export job for the API. A signed download URL is attached by the
 *  caller (only when ready) so this stays pure and free of S3. */
export function serializeExport(job: ExportJobDoc, downloadUrl?: string | null): SessionExport {
  return {
    id: String(job._id),
    sessionId: String(job.sessionId),
    status: job.status as SessionExport["status"],
    screenCount: job.screenCount ?? null,
    bytes: job.bytes ?? null,
    downloadUrl: downloadUrl ?? null,
    error: job.error ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/**
 * Build the ZIP for one export job, then mark it ready (FR-AP-042).
 *
 * The archiver stream is piped into a multipart S3 upload through a PassThrough,
 * so the whole thing streams: an image is read from S3, deflated, and pushed to
 * the upload without ever holding more than a buffer or two — a gigabyte session
 * costs megabytes of memory. Screenshots that have vanished from storage (a
 * concurrent FR-AP-043 delete) are logged and skipped rather than failing the
 * whole archive; a partial ZIP of what still exists beats no ZIP at all.
 */
export async function buildExport(exportId: string): Promise<void> {
  const job = await ExportJobModel.findById(exportId);
  if (!job || job.status !== "pending") return;

  const screens = await ScreenModel.find({ sessionId: job.sessionId }).sort({ capturedAt: 1, _id: 1 });
  const key = exportKey(String(job.sessionId), exportId);

  const archive = archiver("zip", { zlib: { level: 9 } });
  const pass = new PassThrough();
  archive.pipe(pass);

  // Surface archiver warnings/errors into the same failure path as everything
  // else. An unhandled 'error' on the archive stream would otherwise crash the
  // process — this is a background job, so it must fail its job, not the server.
  let archiveError: Error | null = null;
  archive.on("warning", (err) => log.warn("export archive warning", { exportId, ...errorFields(err) }));
  archive.on("error", (err: Error) => {
    archiveError = err;
  });

  // Run the upload and the appending concurrently: the upload drains `pass` as
  // archiver fills it, which is what keeps memory flat.
  const uploadDone = uploadStream(key, pass, "application/zip");

  let written = 0;
  for (const [index, screen] of screens.entries()) {
    if (archiveError) break;
    try {
      const stream = await getObjectStream(screen.s3Key);
      archive.append(stream, {
        name: entryName(index, String(screen._id), screen.url, extOf(screen.s3Key)),
      });
      written += 1;
    } catch (err) {
      log.warn("export skipped a missing screenshot", {
        exportId,
        screenId: String(screen._id),
        ...errorFields(err),
      });
    }
  }

  await archive.finalize();
  const bytes = await uploadDone;
  if (archiveError) throw archiveError;

  await ExportJobModel.updateOne(
    { _id: job._id },
    { $set: { status: "ready", s3Key: key, bytes, screenCount: written } },
  );
  log.info("session export ready", { exportId, sessionId: String(job.sessionId), screens: written, bytes });
}

/**
 * Kick off a build without blocking the response (FR-AP-042). Over the
 * concurrency ceiling the job simply stays `pending` and a later request (or a
 * poll that re-triggers) picks it up — the row is durable, so nothing is lost.
 */
export function queueExport(exportId: string): void {
  if (inFlight >= MAX_CONCURRENT) return;
  inFlight += 1;
  void buildExport(exportId)
    .catch(async (err: unknown) => {
      log.error("session export failed", { exportId, ...errorFields(err) });
      // Record the failure so the poller stops waiting and can show why.
      await ExportJobModel.updateOne(
        { _id: exportId, status: "pending" },
        { $set: { status: "failed", error: "Export failed while building the archive." } },
      ).catch(() => {
        /* the job row may be gone (project purged mid-build) — nothing to do */
      });
    })
    .finally(() => {
      inFlight -= 1;
    });
}

/** Attach a signed download URL to a ready job; pure passthrough otherwise. */
export async function withDownloadUrl(job: ExportJobDoc): Promise<SessionExport> {
  if (job.status === "ready" && job.s3Key) {
    return serializeExport(job, await presignGet(job.s3Key));
  }
  return serializeExport(job);
}
