import type { Screen, ScreenListQuery } from "@snapcrawl/shared";
import type { ScreenDoc } from "../../models/screen";
import { escapeRegex } from "../projects/service";

// Capture helpers (FR-BE-040/041). Pure key-building/filter/serialization so they
// are unit-testable without S3 or a DB.

/** Server-generated object key for a screenshot. The extension never chooses it. */
export function screenKey(sessionId: string, fingerprint: string, contentType: string): string {
  const ext = contentType === "image/webp" ? "webp" : "png";
  const safeFp = fingerprint.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "state";
  return `sessions/${sessionId}/${safeFp}.${ext}`;
}

/** GET /sessions/:id/screens Mongo filter: session-scoped + gallery filters
 *  (url substring, depth, duplicate) + cursor (FR-AP-040). */
export function screenListFilter(
  sessionId: string,
  opts: Pick<ScreenListQuery, "cursor" | "url" | "depth" | "duplicate">,
): Record<string, unknown> {
  const filter: Record<string, unknown> = { sessionId };
  if (opts.cursor) filter._id = { $lt: opts.cursor };
  if (opts.url && opts.url.trim()) filter.url = { $regex: escapeRegex(opts.url.trim()), $options: "i" };
  if (opts.depth !== undefined) filter.depth = opts.depth;
  if (opts.duplicate !== undefined) filter.isDuplicate = opts.duplicate;
  return filter;
}

type ScreenUrls = { imageUrl?: string | null; thumbUrl?: string | null };

/** Map a screen document to the shared `Screen` shape. Signed URLs are attached
 *  by the caller: `thumbUrl` on gallery list + detail, `imageUrl` on detail only. */
export function serializeScreen(s: ScreenDoc, urls?: ScreenUrls): Screen {
  const te = s.triggerElement;
  return {
    id: String(s._id),
    sessionId: String(s.sessionId),
    projectId: String(s.projectId),
    fingerprint: s.fingerprint,
    url: s.url,
    title: s.title ?? "",
    depth: s.depth ?? 0,
    parentScreenId: s.parentScreenId ? String(s.parentScreenId) : null,
    triggerElement: te
      ? { selector: te.selector ?? "", text: te.text ?? "", tag: te.tag ?? "", role: te.role ?? null }
      : null,
    contentHash: s.contentHash,
    width: s.width ?? null,
    height: s.height ?? null,
    fullPage: s.fullPage ?? false,
    isDuplicate: s.isDuplicate ?? false,
    capturedAt: s.capturedAt ?? null,
    createdAt: s.createdAt,
    imageUrl: urls?.imageUrl ?? undefined,
    thumbUrl: urls?.thumbUrl ?? undefined,
  };
}

/** Thumbnail object key for a screen (FR-BE-042). Falls back to the full-image
 *  key until real WebP thumbnails are generated. */
export function thumbKeyOf(s: Pick<ScreenDoc, "thumbKey" | "s3Key">): string {
  return s.thumbKey ?? s.s3Key;
}
