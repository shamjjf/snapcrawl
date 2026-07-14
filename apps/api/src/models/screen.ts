import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

// screens collection (SRS §8.4). Unique per (sessionId, fingerprint) — a state
// is captured exactly once (FR-BE-041). s3Key/thumbKey point at the binaries.
const triggerElementSchema = new Schema(
  {
    selector: { type: String },
    text: { type: String },
    tag: { type: String },
    role: { type: String },
  },
  { _id: false },
);

const screenSchema = new Schema(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: "Session", required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    fingerprint: { type: String, required: true },
    url: { type: String, required: true },
    title: { type: String, default: "" },
    depth: { type: Number, default: 0 },
    parentScreenId: { type: Schema.Types.ObjectId, ref: "Screen" },
    triggerElement: { type: triggerElementSchema },
    s3Key: { type: String, required: true },
    thumbKey: { type: String },
    contentHash: { type: String, required: true },
    pHash: { type: String },
    width: { type: Number },
    height: { type: Number },
    fullPage: { type: Boolean, default: false },
    // Set by near-duplicate detection (FR-BE-043); false until pHash lands.
    isDuplicate: { type: Boolean, default: false },
    capturedAt: { type: Date },
  },
  { timestamps: true },
);

// Indexes (§8.5): unique state per session; content-hash dedupe; capture order.
screenSchema.index({ sessionId: 1, fingerprint: 1 }, { unique: true });
screenSchema.index({ sessionId: 1, contentHash: 1 });
screenSchema.index({ sessionId: 1, capturedAt: 1 });

export type ScreenDoc = HydratedDocument<
  InferSchemaType<typeof screenSchema> & { createdAt: Date; updatedAt: Date }
>;
export const ScreenModel = model("Screen", screenSchema);
