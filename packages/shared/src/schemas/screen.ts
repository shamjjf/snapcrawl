// Screen response entity (SRS §8.4) — a captured UI state. The image bytes live
// in S3; the API exposes only metadata plus a short-lived signed `imageUrl` on
// single-screen reads (FR-BE-044). s3Key/thumbKey are never exposed.
import { z } from "zod";
import { cursorQuerySchema, objectIdSchema } from "./common.js";
import { elementDescriptorSchema } from "./element.js";

export const screenSchema = z.object({
  id: objectIdSchema,
  sessionId: objectIdSchema,
  projectId: objectIdSchema,
  fingerprint: z.string(),
  url: z.string(),
  title: z.string().default(""),
  depth: z.number().int().min(0),
  parentScreenId: objectIdSchema.nullable().optional(),
  triggerElement: elementDescriptorSchema.nullable().optional(),
  contentHash: z.string(),
  width: z.number().int().nonnegative().nullable().optional(),
  height: z.number().int().nonnegative().nullable().optional(),
  fullPage: z.boolean().default(false),
  /** Near/exact-duplicate flag for the gallery filter (FR-BE-043; currently a
   *  placeholder that stays false until pHash detection lands). */
  isDuplicate: z.boolean().default(false),
  capturedAt: z.coerce.date().nullable().optional(),
  createdAt: z.coerce.date(),
  /** Signed GET URL for the full image — present only on single-screen reads (FR-BE-044). */
  imageUrl: z.url().nullable().optional(),
  /** Signed GET URL for the thumbnail — present on gallery list + detail (FR-BE-042). */
  thumbUrl: z.url().nullable().optional(),
});

export type Screen = z.infer<typeof screenSchema>;

/** GET /sessions/:id/screens query: cursor + gallery filters (FR-AP-040). */
export const screenListQuerySchema = cursorQuerySchema.extend({
  cursor: objectIdSchema.optional(),
  url: z.string().trim().max(200).optional(),
  depth: z.coerce.number().int().min(0).optional(),
  duplicate: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

export type ScreenListQuery = z.infer<typeof screenListQuerySchema>;
