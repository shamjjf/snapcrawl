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
  /** null = unlimited. A crawl runs until the user stops it.
   *
   *  Deliberately `number | null` rather than a 0/-1 sentinel. The project form
   *  is `noValidate`, so its min/max attributes are inert and Zod is the only
   *  submit gate — and an empty number field parses to 0. A numeric sentinel
   *  would therefore turn "user cleared the field to retype it" into a legal,
   *  saveable value meaning UNLIMITED on a crawler that clicks real buttons on
   *  live sites. `null` is unreachable from a number input; only a deliberate
   *  checkbox produces it. It also can't collide with maxDepth 0, which already
   *  means "capture the seed, expand nothing". */
  maxDepth: z.number().int().min(1).max(20).nullable().default(null),
  maxScreens: z.number().int().min(1).max(5000).nullable().default(null),
  maxDurationMin: z.number().int().min(1).max(240).nullable().default(null),
  clickDelayMs: z.number().int().min(0).max(10000).default(800),
  stabilityTimeoutMs: z.number().int().min(500).max(60000).default(8000),
  viewport: viewportSchema.default({ width: 1366, height: 900 }),
  fullPage: z.boolean().default(false),
  siblingCollapseLimit: z.number().int().min(0).max(50).default(2),
  /** Allow the crawler to click submit-type elements inside forms (FR-EX-034).
   *  Off by default: v1 never fills fields, so clicking a submit fires the form
   *  with whatever is (or isn't) in it. Destructive-blocklist matches are still
   *  never clicked, regardless of this flag. */
  clickSubmitEmptyForms: z.boolean().default(false),
  /** FR-EX-035 — before clicking a form submit, fill that form's empty text-like
   *  fields with dummy presets (name/email/text) so the submit reaches a real
   *  post-submit state instead of a validation wall. Only meaningful together with
   *  clickSubmitEmptyForms (fill without submit does nothing). Dummy values only —
   *  never a real secret (C-05). Off by default. */
  formFillDummyData: z.boolean().default(false),
  /** FR-EX-052 — pro capture mode: use chrome.debugger (CDP captureBeyondViewport)
   *  for pixel-perfect full-page screenshots instead of scroll-and-stitch. Shows
   *  Chrome's "extension is debugging this browser" banner for the whole crawl
   *  (C-02, disclosed in the popup). Falls back to scroll-and-stitch if the
   *  debugger can't attach. Off by default. */
  proCaptureMode: z.boolean().default(false),
  /** FR-EX-090 — default this project's crawls to the phone. A run captures ONE
   *  device: in mobile mode chrome.debugger emulates the phone for the whole
   *  crawl, so the page loads with a mobile UA and Client Hints and you get the
   *  real mobile site rather than a narrowed desktop one. The popup can override
   *  it per run. Off by default. */
  captureMobile: z.boolean().default(false),
  /** FR-EX-090 — the emulated phone. Defaults to iPhone 14 Pro Max (430×932). */
  mobileViewport: viewportSchema.default({ width: 430, height: 932 }),
  /** FR-EX-033 — extra pause after the page has settled (images, fonts) and
   *  BEFORE the shutter. Entrance animations, skeleton loaders and content that
   *  streams in after first paint are all invisible to a stability check that
   *  only watches the DOM and the network, so a plain wait is the only thing
   *  that catches them. Costs this much per screen — raise it for a prettier
   *  capture, lower it for a faster crawl. */
  captureSettleMs: z.number().int().min(0).max(60000).default(2000),
  /** FR-EX-076 — URL substrings that mean the crawl has landed on a login/logout
   *  page (it got logged out, or clicked its way to one). The crawl auto-pauses
   *  and asks the user to re-authenticate. Substring match, case-insensitive. */
  loginUrlPatterns: z.array(z.string()).default(["/login", "/signin", "/logout"]),
});

/** Read-back schema for a HISTORICAL config snapshot (FR-BE-030).
 *
 *  Identical to crawlConfigSchema except the three limits default to what they
 *  defaulted to before unlimited existed. crawlConfigSchema.parse fills defaults
 *  PER FIELD, so with the live default now null, a stored snapshot that is empty
 *  — or merely missing one limit key — would come back claiming the completed
 *  run had been allowed to crawl forever. A finished session must keep
 *  describing what it was actually permitted to do, so gaps resolve
 *  conservatively-finite here. Use ONLY on the read path for stored snapshots;
 *  never for validating new input. */
export const legacyConfigSchema = crawlConfigSchema.extend({
  maxDepth: z.number().int().min(1).max(20).nullable().default(5),
  maxScreens: z.number().int().min(1).max(5000).nullable().default(200),
  maxDurationMin: z.number().int().min(1).max(240).nullable().default(30),
});

export type Viewport = z.infer<typeof viewportSchema>;
export type CrawlConfig = z.infer<typeof crawlConfigSchema>;
