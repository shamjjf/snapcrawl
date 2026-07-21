// Audit trail (FR-BE-012) + the authorised-use attestation (NFR-020, C-07).
// SRS §8.4: auditLogs | userId→, action, targetType, targetId, ip, userAgent, createdAt
import { z } from "zod";
import { objectIdSchema } from "./common.js";

/** Security-relevant events that must leave a trail (FR-BE-012), plus the
 *  authorised-use confirmation NFR-020 requires be stored in the audit log.
 *  Dotted `domain.thing.verb` so the set stays greppable and groupable. */
export const auditActionSchema = z.enum([
  "auth.login.success",
  "auth.login.failure",
  /** Too many consecutive failures — the account was locked (FR-BE-007). */
  "auth.account.locked",
  "auth.password.change",
  "auth.password.reset.request",
  "auth.password.reset.complete",
  /** Email verification (FR-BE-008): a link was requested, and later consumed. */
  "auth.email.verification.request",
  "auth.email.verified",
  "user.role.change",
  "token.create",
  "token.revoke",
  /** Someone was granted or lost access to a project (FR-BE-024). Membership is
   *  an access-control change, so it belongs in the trail next to role changes. */
  "project.member.add",
  "project.member.remove",
  /** A user soft-deleted a project — it disappears and is scheduled for cascade
   *  (FR-BE-025). This is the human act, so it stays the primary record. */
  "project.delete",
  /** …undone within the grace period. */
  "project.restore",
  /** The grace period ran out and the cascade actually removed the data
   *  (FR-BE-025). Distinct from `project.delete`, and with a null actor: nobody
   *  did this, a timer did, and the trail should not imply otherwise. */
  "project.purge",
  "project.authorised_use",
  "session.cancel",
  /** A screenshot was deleted, binary and all (FR-AP-043). */
  "screen.delete",
]);

export const auditTargetTypeSchema = z.enum([
  "user",
  "token",
  "project",
  "session",
  "screen",
]);

/** One audit record as the API returns it. */
export const auditLogEntrySchema = z.object({
  id: objectIdSchema,
  /** Null when the actor is unknown — e.g. a login attempt for an email that
   *  does not exist. The attempted identifier is kept in `targetId`. */
  userId: objectIdSchema.nullable(),
  action: auditActionSchema,
  targetType: auditTargetTypeSchema.nullable(),
  targetId: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.coerce.date(),
});

export type AuditAction = z.infer<typeof auditActionSchema>;
export type AuditTargetType = z.infer<typeof auditTargetTypeSchema>;
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

// ── Authorised-use gate (NFR-020) ───────────────────────────────────────────

/** POST /projects/:id/authorise body. `confirm` must be the literal `true`:
 *  an empty or malformed body must never be able to attest on a user's behalf
 *  that they are authorised to point a crawler at a live site (C-07). */
export const projectAuthoriseSchema = z.object({
  confirm: z.literal(true),
});

/** The stored attestation, surfaced on the Project so the panel knows whether
 *  to prompt (FR-AP-*) and the extension can explain a 403. */
export const authorisedUseSchema = z.object({
  at: z.coerce.date(),
  by: objectIdSchema,
});

export type ProjectAuthorise = z.infer<typeof projectAuthoriseSchema>;
export type AuthorisedUse = z.infer<typeof authorisedUseSchema>;
