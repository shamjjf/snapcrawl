// Personal extension token DTOs (FR-BE-060). The raw token is returned exactly
// once on create; only its SHA-256 hash is ever stored server-side.
import { z } from "zod";
import { objectIdSchema } from "./common.js";

export const tokenCreateSchema = z.object({
  name: z.string().min(1).max(80),
  expiresAt: z.coerce.date().optional(),
});

export type TokenCreate = z.infer<typeof tokenCreateSchema>;

// ── Response entities (what the API returns; SRS §8.2) ──────────────────────
// Added for the admin panel's token page (FR-AP-061). The panel view NEVER
// includes the raw token or its hash — only lifecycle metadata.

/** v1 scopes are fixed to ["capture"] (SRS §8.2). */
export const tokenScopeSchema = z.enum(["capture"]);

/** Safe token record for the panel — no tokenHash, no raw token (FR-BE-060). */
export const apiTokenSchema = z.object({
  id: objectIdSchema,
  name: z.string(),
  scopes: z.array(tokenScopeSchema).default(["capture"]),
  lastUsedAt: z.coerce.date().nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  revokedAt: z.coerce.date().nullable().optional(),
  createdAt: z.coerce.date(),
});

/** Create response: the raw token is present exactly once, here (FR-BE-060). */
export const tokenCreateResponseSchema = z.object({
  token: apiTokenSchema,
  rawToken: z.string().min(1),
});

export type TokenScope = z.infer<typeof tokenScopeSchema>;
export type ApiToken = z.infer<typeof apiTokenSchema>;
export type TokenCreateResponse = z.infer<typeof tokenCreateResponseSchema>;
