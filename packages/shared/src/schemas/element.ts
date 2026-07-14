// A trigger/target element descriptor, referenced by screens and edges
// (SRS §8.4: triggerElement / edge.element = { selector, text, tag, role }).
import { z } from "zod";

export const elementDescriptorSchema = z.object({
  selector: z.string(),
  text: z.string().default(""),
  tag: z.string(),
  role: z.string().nullable().optional(),
});

export type ElementDescriptor = z.infer<typeof elementDescriptorSchema>;
