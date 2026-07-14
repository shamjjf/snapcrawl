// Sitemap graph response (FR-BE-050). Nodes are captured screens, edges are the
// recorded click transitions — shaped for direct rendering (e.g. react-flow).
import { z } from "zod";
import { objectIdSchema } from "./common.js";
import { edgeKindSchema } from "./edge.js";
import { elementDescriptorSchema } from "./element.js";

export const graphNodeSchema = z.object({
  id: objectIdSchema,
  url: z.string(),
  title: z.string().default(""),
  depth: z.number().int().min(0),
  thumbUrl: z.url().nullable().optional(),
});

export const graphEdgeSchema = z.object({
  id: objectIdSchema,
  from: objectIdSchema.nullable(),
  to: objectIdSchema.nullable(),
  element: elementDescriptorSchema.nullable().optional(),
  kind: edgeKindSchema,
});

export const sessionGraphSchema = z.object({
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
});

export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphEdge = z.infer<typeof graphEdgeSchema>;
export type SessionGraph = z.infer<typeof sessionGraphSchema>;
