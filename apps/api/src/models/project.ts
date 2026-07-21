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
    // null = unlimited: a crawl runs until the user stops it. Existing documents
    // keep their stored 5/200/30 and are NOT silently unbounded — flip them
    // deliberately with scripts/unlimit-projects.ts.
    maxDepth: { type: Number, default: null },
    maxScreens: { type: Number, default: null },
    maxDurationMin: { type: Number, default: null },
    clickDelayMs: { type: Number, default: 800 },
    stabilityTimeoutMs: { type: Number, default: 8000 },
    viewport: { type: viewportSchema, default: () => ({}) },
    fullPage: { type: Boolean, default: false },
    siblingCollapseLimit: { type: Number, default: 2 },
    clickSubmitEmptyForms: { type: Boolean, default: false }, // FR-EX-034
    formFillDummyData: { type: Boolean, default: false }, // FR-EX-035
    proCaptureMode: { type: Boolean, default: false }, // FR-EX-052
    loginUrlPatterns: { type: [String], default: ["/login", "/signin", "/logout"] }, // FR-EX-076
  },
  { _id: false },
);

// The authorised-use attestation (NFR-020, C-07): who confirmed they own or are
// authorised to test this target, and when.
//
// Stored on the project as well as in the audit log. The audit row is the event
// record NFR-020 asks for, but §8.5 retires audit rows after 12 months — and an
// attestation that silently expires would re-open the gate on a live project.
// This field is the durable one, and the gate reads it on every session create.
const authorisedUseSchema = new Schema(
  {
    at: { type: Date, required: true },
    by: { type: Schema.Types.ObjectId, ref: "User", required: true },
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
    // Absent until confirmed. NO DEFAULT — absent must stay absent, so the gate
    // can tell "never attested" from anything else.
    authorisedUse: { type: authorisedUseSchema },
    // Soft delete (FR-BE-025). Absent/null ⇒ live. Set ⇒ hidden everywhere and
    // scheduled for cascade once the grace period elapses. No default, for the
    // same reason as authorisedUse: `{deletedAt: null}` in Mongo matches missing
    // AND null, so absent reads as live without needing a backfill.
    deletedAt: { type: Date },
  },
  { timestamps: true },
);

// The purge sweep's only query: find projects whose grace period has expired.
projectSchema.index({ deletedAt: 1 });

export type ProjectDoc = HydratedDocument<
  InferSchemaType<typeof projectSchema> & { createdAt: Date; updatedAt: Date }
>;
export const ProjectModel = model("Project", projectSchema);
