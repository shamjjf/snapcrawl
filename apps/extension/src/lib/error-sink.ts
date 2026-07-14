// Crawl error store (FR-EX-082) — the local, resilient error log.
//
// The engine appends a structured entry every time it swallows a failure
// (capture failed, click failed, page crashed, off-scope, …) so the popup's
// "View errors" list can show WHAT went wrong — even after Stop, after the popup
// is reopened, and across a service-worker eviction (C-03), since it lives in
// chrome.storage.local, not worker memory. The same entries are also uploaded
// to the backend in batches (FR-EX-084) for the panel's session log; this sink
// is the always-available fallback that never depends on pairing or network.

const ERRORS_KEY = "sc-crawl-errors";
const MAX_ERRORS = 200; // plenty for a run; bounds storage if a page misbehaves

/** One recorded crawl error. `at` is epoch-ms (JSON-safe); `context` is a short
 *  string or small JSON blob describing where/why it happened. */
export interface CrawlErrorEntry {
  level: "error" | "warn" | "info";
  event: string;
  context?: unknown;
  at: number;
}

/** Clear errors from a previous run. Call at crawl start. */
export async function resetCrawlErrors(): Promise<void> {
  try {
    await chrome.storage.local.set({ [ERRORS_KEY]: [] });
  } catch {
    /* not in an extension context */
  }
}

/** Read the recorded errors back in order (newest last). */
export async function getCrawlErrors(): Promise<CrawlErrorEntry[]> {
  try {
    const r = await chrome.storage.local.get(ERRORS_KEY);
    const v = r[ERRORS_KEY];
    return Array.isArray(v) ? (v as CrawlErrorEntry[]) : [];
  } catch {
    return [];
  }
}

/** Append one error, keeping at most the last MAX_ERRORS. Best-effort. */
export async function putCrawlError(entry: CrawlErrorEntry): Promise<void> {
  try {
    const list = await getCrawlErrors();
    const next = [...list, entry].slice(-MAX_ERRORS);
    await chrome.storage.local.set({ [ERRORS_KEY]: next });
  } catch {
    /* ignore — the batched upload is the other path to the panel */
  }
}
