// Screenshot capture pipeline DTOs: presign (dedupe check) then complete
// (persist screen) — FR-BE-040/041, FR-EX-050..055. Image bytes go straight to
// S3 via the presigned URL; only metadata transits the API.
import { z } from "zod";
import { objectIdSchema } from "./common.js";
import { viewportSchema } from "./config.js";
import { elementDescriptorSchema } from "./element.js";

/** Per-capture metadata carried on every screenshot (FR-EX-054). */
export const captureMetaSchema = z.object({
  url: z.string(),
  title: z.string().default(""),
  depth: z.number().int().min(0),
  parentFingerprint: z.string().nullable().optional(),
  triggerElement: elementDescriptorSchema.nullable().optional(),
  viewport: viewportSchema,
  fullPage: z.boolean().default(false),
  clientTimestamp: z.coerce.date().optional(),
  /** FR-EX-090 — which rendering this image is. "mobile" rows are the emulated
   *  phone companion of a desktop capture; they are excluded from the gallery,
   *  sitemap and coverage by default so those keep counting STATES, not images.
   *  Absent means desktop, which is why no backfill of existing rows is needed. */
  variant: z.enum(["desktop", "mobile"]).default("desktop"),
  /** FR-EX-090 — set on a mobile row when the page did NOT actually re-render at
   *  phone width (structural signature unchanged after a 3.5× width change and no
   *  meta viewport). The image is a squeezed desktop layout, not a real mobile
   *  render, and must be labelled as such rather than presented as genuine. */
  mobileReflowed: z.boolean().optional(),
});

/** Presign request: dedupe by contentHash, else hand back a PUT URL (FR-BE-040). */
export const presignRequestSchema = z.object({
  sessionId: objectIdSchema,
  stateFingerprint: z.string().min(1),
  contentHash: z.string().min(1),
  contentType: z.enum(["image/png", "image/webp"]).default("image/png"),
  meta: captureMetaSchema,
});

/** Presign response: duplicate → skip upload; otherwise a time-limited PUT URL. */
export const presignResponseSchema = z.object({
  duplicate: z.boolean(),
  uploadUrl: z.url().optional(),
  key: z.string().optional(),
  expiresInSec: z.number().int().positive().optional(),
});

/** Completion: after the client PUT succeeds, persist the screen (FR-BE-041). */
export const captureCompleteSchema = z.object({
  sessionId: objectIdSchema,
  stateFingerprint: z.string().min(1),
  contentHash: z.string().min(1),
  key: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  meta: captureMetaSchema,
});

export type CaptureMeta = z.infer<typeof captureMetaSchema>;
export type PresignRequest = z.infer<typeof presignRequestSchema>;
export type PresignResponse = z.infer<typeof presignResponseSchema>;
export type CaptureComplete = z.infer<typeof captureCompleteSchema>;
