// Crawl screenshot store (FR-EX-055) — the memory-safety layer.
//
// Instead of accumulating every screenshot in an in-memory array (the old
// unbounded `shots: string[]`), each capture is written to its own
// chrome.storage.local key the moment it's taken and dropped from memory. The
// crawl loop therefore holds at most the single in-flight blob. The ZIP export
// (and the upload backlog) read the shots back from storage afterwards.

const COUNT_KEY = "sc-crawl-count";
const SHOT_PREFIX = "sc-crawl-shot-";
const shotKey = (seq: number): string => `${SHOT_PREFIX}${seq}`;

/** Clear any shots from a previous run. Call at crawl start. */
export async function resetCrawlShots(): Promise<void> {
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(SHOT_PREFIX));
    keys.push(COUNT_KEY);
    await chrome.storage.local.remove(keys);
  } catch {
    /* not in an extension context */
  }
}

/** Persist one capture and advance the count. Keeps nothing in memory. */
export async function putCrawlShot(seq: number, dataUrl: string): Promise<void> {
  try {
    await chrome.storage.local.set({ [shotKey(seq)]: dataUrl, [COUNT_KEY]: seq + 1 });
  } catch {
    /* ignore */
  }
}

/** Read all stored shots back in order (for the ZIP export — post-crawl only). */
export async function getCrawlShots(): Promise<string[]> {
  try {
    const meta = await chrome.storage.local.get(COUNT_KEY);
    const count = typeof meta[COUNT_KEY] === "number" ? (meta[COUNT_KEY] as number) : 0;
    if (count === 0) return [];
    const keys = Array.from({ length: count }, (_, i) => shotKey(i));
    const got = await chrome.storage.local.get(keys);
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      const v = got[shotKey(i)];
      if (typeof v === "string") out.push(v);
    }
    return out;
  } catch {
    return [];
  }
}
