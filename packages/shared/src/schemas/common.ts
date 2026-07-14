// Cross-cutting schema primitives shared by every domain (SRS §4.8, §7).
import { z } from "zod";

/** Mongo ObjectId as a 24-char hex string (used wherever the API takes an id). */
export const objectIdSchema = z
  .string()
  .regex(/^[a-f\d]{24}$/i, "Must be a 24-character hex ObjectId");

/** One field-level problem inside the uniform error envelope (FR-BE-070). */
export const errorDetailSchema = z.object({
  path: z.string(),
  message: z.string(),
});

/** Uniform API error envelope `{ code, message, details[] }` (FR-BE-070). */
export const errorEnvelopeSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.array(errorDetailSchema).optional(),
});

/** Cursor-based list query — the ONE pagination style for every list endpoint
 *  (FR-BE-073). `cursor` is an opaque token (an ObjectId hex in practice);
 *  `limit` is capped at 100 so results are never unbounded. */
export const cursorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

/** Shared list envelope — the single source of truth for every list response
 *  (FR-BE-073). `nextCursor` is null when there are no more items. Callers pass
 *  it back as `?cursor=` to fetch the next page. */
export const pageSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable().default(null),
  });

export type Page<T> = { items: T[]; nextCursor: string | null };

export type ObjectIdString = z.infer<typeof objectIdSchema>;
export type ErrorDetail = z.infer<typeof errorDetailSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export type CursorQuery = z.infer<typeof cursorQuerySchema>;
