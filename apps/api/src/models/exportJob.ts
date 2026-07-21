import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

// exportJobs collection: a server-generated session ZIP (FR-AP-042). The build
// is asynchronous, so a row here IS the notification channel — the panel creates
// one, then polls it until status flips to `ready` and a download URL appears.
//
// projectId is denormalised from the session so the FR-BE-025 purge cascade can
// find and delete a project's export objects without walking sessions first.
const exportJobSchema = new Schema(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: "Session", required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: ["pending", "ready", "failed"],
      default: "pending",
      index: true,
    },
    // Set only once status is `ready`. The ZIP lives in the same bucket as the
    // screenshots and is served the same way — a short-lived signed GET, never
    // a public URL (FR-BE-044).
    s3Key: { type: String },
    bytes: { type: Number },
    screenCount: { type: Number },
    // A human-readable reason when status is `failed`, surfaced to the panel.
    error: { type: String },
  },
  { timestamps: true },
);

export type ExportJobDoc = HydratedDocument<
  InferSchemaType<typeof exportJobSchema> & { createdAt: Date; updatedAt: Date }
>;
export const ExportJobModel = model("ExportJob", exportJobSchema);
