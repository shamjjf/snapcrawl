import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { DEFAULT_DESTRUCTIVE_BLOCKLIST } from "@snapcrawl/shared";

// projects collection (SRS §8.3). The embedded config subdoc mirrors the
// crawlConfig shape in @snapcrawl/shared (FR-BE-021); defaults match FR-BE-021/022.
const viewportSchema = new Schema(
  { width: { type: Number, default: 1366 }, height: { type: Number, default: 900 } },
  { _id: false },
);

const crawlConfigSchema = new Schema(
  {
    allowedDomains: { type: [String], default: [] },
    excludeSelectors: { type: [String], default: [] },
    excludeUrlPatterns: { type: [String], default: [] },
    destructiveTextBlocklist: {
      type: [String],
      default: () => [...DEFAULT_DESTRUCTIVE_BLOCKLIST],
    },
    maskSelectors: { type: [String], default: [] },
    maxDepth: { type: Number, default: 5 },
    maxScreens: { type: Number, default: 200 },
    maxDurationMin: { type: Number, default: 30 },
    clickDelayMs: { type: Number, default: 800 },
    stabilityTimeoutMs: { type: Number, default: 8000 },
    viewport: { type: viewportSchema, default: () => ({}) },
    fullPage: { type: Boolean, default: false },
    siblingCollapseLimit: { type: Number, default: 2 },
  },
  { _id: false },
);

const projectSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    memberIds: { type: [Schema.Types.ObjectId], ref: "User", default: [] },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    baseUrl: { type: String, required: true },
    config: { type: crawlConfigSchema, default: () => ({}) },
    status: {
      type: String,
      enum: ["active", "archived", "pending-delete"],
      default: "active",
      index: true,
    },
  },
  { timestamps: true },
);

export type ProjectDoc = HydratedDocument<
  InferSchemaType<typeof projectSchema> & { createdAt: Date; updatedAt: Date }
>;
export const ProjectModel = model("Project", projectSchema);
