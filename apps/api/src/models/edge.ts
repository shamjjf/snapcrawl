import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

// edges collection (SRS §8.4). A recorded transition: clicking `element` on
// fromScreen produced toScreen. kind distinguishes navigation vs substate vs
// dead (no UI change). Persisted idempotently in batches (FR-BE-045).
const elementSchema = new Schema(
  {
    selector: { type: String },
    text: { type: String },
    tag: { type: String },
    role: { type: String },
  },
  { _id: false },
);

const edgeSchema = new Schema(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: "Session", required: true, index: true },
    fromScreenId: { type: Schema.Types.ObjectId, ref: "Screen" },
    toScreenId: { type: Schema.Types.ObjectId, ref: "Screen" },
    element: { type: elementSchema },
    kind: {
      type: String,
      enum: ["navigation", "substate", "dead"],
      default: "navigation",
    },
  },
  { timestamps: true },
);

// Idempotency (FR-BE-045): one edge per (session, from, to, selector, kind).
edgeSchema.index(
  { sessionId: 1, fromScreenId: 1, toScreenId: 1, "element.selector": 1, kind: 1 },
  { unique: true },
);

export type EdgeDoc = HydratedDocument<InferSchemaType<typeof edgeSchema>>;
export const EdgeModel = model("Edge", edgeSchema);
