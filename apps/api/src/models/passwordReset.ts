import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

// passwordResets collection (FR-BE-005). One row per reset request. Mirrors the
// refreshTokens design: only the SHA-256 hash of the raw token is stored, so a
// database leak cannot be replayed into an account takeover.
//
// Single-use is enforced by an atomic claim on `usedAt` (see the service), not
// by a read-then-write — two clicks on the same emailed link must not both reset.
const passwordResetSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
  },
  { timestamps: true },
);

// Housekeeping: Mongo drops rows once expired. These are single-use and
// short-lived, so there is nothing to keep afterwards — and unlike the audit
// trail, no requirement to retain them.
passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type PasswordResetDoc = HydratedDocument<
  InferSchemaType<typeof passwordResetSchema> & { createdAt: Date; updatedAt: Date }
>;
export const PasswordResetModel = model("PasswordReset", passwordResetSchema);
