import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

// users collection (SRS §8.1). passwordHash is never returned by the API.
const userSchema = new Schema(
  {
    name: { type: String, required: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: { type: String, required: true },
    role: {
      type: String,
      enum: ["admin", "member", "viewer"],
      default: "member",
    },
    status: {
      type: String,
      enum: ["active", "deactivated"],
      default: "active",
    },
    lastLoginAt: { type: Date },
    // Brute-force lockout (FR-BE-007). Counts CONSECUTIVE failures — reset to 0
    // on any successful login, so a user who mistypes twice a week is never
    // locked out. Both are mutated only via atomic $inc/$set, never through a
    // hydrated doc, so concurrent attempts can't lose a count.
    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date },
    // Email verification (FR-BE-008). When and whether it is REQUIRED is a
    // deployment choice (REQUIRE_EMAIL_VERIFICATION); this field just records
    // the fact. Absent ⇒ never verified. No default: a boolean default would
    // have to be `false`, which for every account created before this feature
    // would assert "confirmed unverified" and, with the flag on, lock out the
    // entire existing user base. Absent is honestly "unknown", and the login
    // gate treats a legacy account (created before the feature) as grandfathered.
    emailVerifiedAt: { type: Date },
  },
  { timestamps: true },
);

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export const UserModel = model("User", userSchema);
