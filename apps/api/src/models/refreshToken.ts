import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

// refreshTokens collection (FR-BE-002/003). One row per issued refresh token.
// Rotation: on use, `usedAt` is stamped and a successor is minted in the same
// `familyId`. Reuse of an already-used token revokes the whole family. Only the
// SHA-256 hash of the raw token is stored.
const refreshTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    familyId: { type: Schema.Types.ObjectId, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
    revokedAt: { type: Date },
  },
  { timestamps: true },
);

export type RefreshTokenDoc = HydratedDocument<
  InferSchemaType<typeof refreshTokenSchema> & { createdAt: Date; updatedAt: Date }
>;
export const RefreshTokenModel = model("RefreshToken", refreshTokenSchema);
