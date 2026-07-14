// Per-project crawl configuration (FR-BE-021). Single source of truth for the
// shape the backend stores, the panel edits, and the extension runs against.
// Numeric ranges here back the write-time validation of FR-BE-023.
import { z } from "zod";
import { DEFAULT_DESTRUCTIVE_BLOCKLIST } from "../constants/index.js";

export const viewportSchema = z.object({
  width: z.number().int().min(320).max(3840),
  height: z.number().int().min(320).max(2160),
});

export const crawlConfigSchema = z.object({
  allowedDomains: z.array(z.string()).default([]),
  excludeSelectors: z.array(z.string()).default([]),
  excludeUrlPatterns: z.array(z.string()).default([]),
  destructiveTextBlocklist: z
    .array(z.string())
    .default([...DEFAULT_DESTRUCTIVE_BLOCKLIST]),
  maskSelectors: z.array(z.string()).default([]),
  maxDepth: z.number().int().min(1).max(20).default(5),
  maxScreens: z.number().int().min(1).max(5000).default(200),
  maxDurationMin: z.number().int().min(1).max(240).default(30),
  clickDelayMs: z.number().int().min(0).max(10000).default(800),
  stabilityTimeoutMs: z.number().int().min(500).max(60000).default(8000),
  viewport: viewportSchema.default({ width: 1366, height: 900 }),
  fullPage: z.boolean().default(false),
  siblingCollapseLimit: z.number().int().min(0).max(50).default(2),
});

export type Viewport = z.infer<typeof viewportSchema>;
export type CrawlConfig = z.infer<typeof crawlConfigSchema>;
