// Batched, idempotent edge upload (FR-BE-045). An edge records that clicking
// `element` on state `fromFingerprint` produced `toFingerprint`.
import { z } from "zod";
import { objectIdSchema } from "./common.js";
import { elementDescriptorSchema } from "./element.js";

export const edgeKindSchema = z.enum(["navigation", "substate", "dead"]);

export const edgeInputSchema = z.object({
  fromFingerprint: z.string().min(1),
  toFingerprint: z.string().nullable().optional(),
  element: elementDescriptorSchema,
  kind: edgeKindSchema.default("navigation"),
});

export const edgeBatchSchema = z.object({
  sessionId: objectIdSchema,
  edges: z.array(edgeInputSchema).min(1).max(100),
});

/** Response to a batch edge upload: how many were newly recorded (FR-BE-045). */
export const edgeBatchResponseSchema = z.object({
  recorded: z.number().int().min(0),
});

export type EdgeKind = z.infer<typeof edgeKindSchema>;
export type EdgeInput = z.infer<typeof edgeInputSchema>;
export type EdgeBatch = z.infer<typeof edgeBatchSchema>;
export type EdgeBatchResponse = z.infer<typeof edgeBatchResponseSchema>;
