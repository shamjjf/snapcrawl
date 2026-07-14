import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

// sessionLogs collection (SRS §8.4, FR-EX-084). Batched engine-decision log
// (clicked, skipped-blocked, dead-edge, dialog-dismissed, …) shown in the panel.
const sessionLogSchema = new Schema(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: "Session", required: true, index: true },
    seq: { type: Number, required: true },
    level: { type: String, default: "info" },
    event: { type: String, required: true },
    context: { type: Schema.Types.Mixed },
    at: { type: Date },
  },
  { timestamps: true },
);

// Query index (§8.5): ordered log per session.
sessionLogSchema.index({ sessionId: 1, seq: 1 });

export type SessionLogDoc = HydratedDocument<
  InferSchemaType<typeof sessionLogSchema> & { createdAt: Date; updatedAt: Date }
>;
export const SessionLogModel = model("SessionLog", sessionLogSchema);
