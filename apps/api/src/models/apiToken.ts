import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

// apiTokens collection (SRS §8.2) — extension pairing. The raw token is never
// stored; only its SHA-256 hash. tokenHash is uniquely indexed (§8.5).
const apiTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    scopes: { type: [String], default: ["capture"] },
    lastUsedAt: { type: Date },
    expiresAt: { type: Date },
    revokedAt: { type: Date },
  },
  { timestamps: true },
);

export type ApiTokenDoc = HydratedDocument<
  InferSchemaType<typeof apiTokenSchema> & { createdAt: Date; updatedAt: Date }
>;
export const ApiTokenModel = model("ApiToken", apiTokenSchema);
