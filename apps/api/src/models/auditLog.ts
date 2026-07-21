import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

// auditLogs collection (SRS §8.4, FR-BE-012). Security-relevant events:
// login success/failure, password change/reset, role change, token
// create/revoke, project deletion, session cancellation, authorised-use gate.
//
// Append-only by convention: no API code path updates or deletes a row. A trail
// that can be rewritten by the same code paths it audits is not a trail. The one
// deletion is time, not code — a TTL index enforces the §8.5 12-month retention
// policy below, which is exactly why the durable authorised-use attestation is
// mirrored onto projects.authorisedUse (that must outlive its audit row).

/** §8.5: audit logs are kept 12 months. 365 days in seconds. */
export const AUDIT_RETENTION_SECONDS = 365 * 24 * 60 * 60;
const auditLogSchema = new Schema(
  {
    // Null when the actor is unknown (a login attempt for an unregistered
    // email). The attempted identifier still lands in targetId.
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    action: { type: String, required: true },
    targetType: { type: String },
    targetId: { type: String },
    ip: { type: String },
    userAgent: { type: String },
  },
  { timestamps: true },
);

// The NFR-020 gate reads this on every session create: "has this project been
// attested?" Without the index that is a collection scan on the hot crawl path.
auditLogSchema.index({ targetType: 1, targetId: 1, action: 1 });
// History reads: what did this user do, newest first.
auditLogSchema.index({ userId: 1, createdAt: -1 });
// Retention (§8.5): Mongo's background TTL monitor deletes rows once createdAt is
// older than 12 months. A native TTL rather than an in-process sweeper on
// purpose — it keeps running whether or not any single API instance is up
// (NFR-004), and there is nothing to retain past the policy window.
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: AUDIT_RETENTION_SECONDS });

export type AuditLogDoc = HydratedDocument<
  InferSchemaType<typeof auditLogSchema> & { createdAt: Date; updatedAt: Date }
>;
export const AuditLogModel = model("AuditLog", auditLogSchema);
