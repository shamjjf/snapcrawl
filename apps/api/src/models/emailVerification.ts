import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

// emailVerifications collection (FR-BE-008). One row per verification request.
// Identical design to passwordResets: only the SHA-256 hash of the raw token is
// stored, single-use is enforced by an atomic claim on `usedAt`, and Mongo's TTL
// index expires stale rows. A verification link is lower-stakes than a reset
// link, but there is no reason to store it any less carefully.
const emailVerificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
  },
  { timestamps: true },
);

emailVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type EmailVerificationDoc = HydratedDocument<
  InferSchemaType<typeof emailVerificationSchema> & { createdAt: Date; updatedAt: Date }
>;
export const EmailVerificationModel = model("EmailVerification", emailVerificationSchema);
