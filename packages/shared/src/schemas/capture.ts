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
