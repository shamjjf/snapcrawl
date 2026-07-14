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
  },
  { timestamps: true },
);

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export const UserModel = model("User", userSchema);
