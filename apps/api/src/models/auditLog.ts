import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

// auditLogs collection (SRS §8.4, FR-BE-012). Security-relevant events:
// login success/failure, password change/reset, role change, token
// create/revoke, project deletion, session cancellation, authorised-use gate.
const auditLogSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    action: { type: String, required: true },
    targetType: { type: String },
    targetId: { type: String },
    ip: { type: String },
    userAgent: { type: String },
  },
  { timestamps: true },
);

export type AuditLogDoc = HydratedDocument<InferSchemaType<typeof auditLogSchema>>;
export const AuditLogModel = model("AuditLog", auditLogSchema);
