import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

// sessions collection (SRS §8.4). configSnapshot is the immutable copy of the
// project config taken at session creation (FR-BE-030); stats are updated
// incrementally by the extension (FR-BE-033).
const statsSchema = new Schema(
  {
    screensCaptured: { type: Number, default: 0 },
    edgesRecorded: { type: Number, default: 0 },
    duplicatesSkipped: { type: Number, default: 0 },
    errorsCount: { type: Number, default: 0 },
    maxDepthReached: { type: Number, default: 0 },
    currentUrl: { type: String, default: "" },
  },
  { _id: false },
);

const sessionSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    tokenId: { type: Schema.Types.ObjectId, ref: "ApiToken" },
    status: {
      type: String,
      enum: ["pending", "running", "paused", "completed", "failed", "cancelled"],
      default: "pending",
      index: true,
    },
    configSnapshot: { type: Schema.Types.Mixed },
    stats: { type: statsSchema, default: () => ({}) },
    startedAt: { type: Date },
    endedAt: { type: Date },
    lastHeartbeatAt: { type: Date },
    endReason: { type: String },
    // Cancellation flag returned to the extension on its next PATCH (FR-BE-034).
    cancelRequested: { type: Boolean, default: false },
    // Monotonic allocator for session-log `seq` (FR-EX-084). Batches reserve a
    // contiguous range with a single atomic $inc, so concurrent uploads can
    // never share one.
    //
    // DELIBERATELY HAS NO DEFAULT. A default would be applied when hydrating any
    // document written before this field existed, and Mongoose puts hydration
    // defaults into the next save()'s $set — even though modifiedPaths() reports
    // the doc as clean. An unrelated `doc.save()` (e.g. a heartbeat PATCH) would
    // then reset the counter to 0 mid-flight and hand the next batch a range that
    // collides with rows already written. With no default, an absent field stays
    // absent, `$inc` creates it, and a session with no logs correctly starts at 0.
    //
    // INVARIANT: only ever mutate this via $inc. Never read-modify-write it
    // through a hydrated doc.
    logSeq: { type: Number },
  },
  { timestamps: true },
);

// Query index (§8.5): newest sessions per project.
sessionSchema.index({ projectId: 1, createdAt: -1 });

export type SessionDoc = HydratedDocument<
  InferSchemaType<typeof sessionSchema> & { createdAt: Date; updatedAt: Date }
>;
export const SessionModel = model("Session", sessionSchema);
