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

// FR-EX-090 — mobile companions live in their own namespace and deliberately do
// NOT touch COUNT_KEY. The count is the resume cursor for desktop shots (see
// getCrawlShotCount); letting mobile advance it would make a resumed run
// overwrite a desktop capture. A missing mobile entry at some seq is fine — the
// ZIP reader simply skips it.
const MSHOT_PREFIX = "sc-crawl-mshot-";
const mshotKey = (seq: number): string => `${MSHOT_PREFIX}${seq}`;

/** Clear any shots from a previous run. Call at crawl start.
 *
 *  Derives the key list ARITHMETICALLY from the stored count, exactly as
 *  getCrawlShots does. `storage.local.get(null)` would materialise every stored
 *  PNG in the service worker just to read their key names — on a long previous
 *  run that OOMs the worker at the START OF THE NEXT CRAWL, which presents as an
 *  unrelated failure with no obvious link to the run that actually caused it.
 *  A stale over-count is harmless: removing a key that isn't there is a no-op. */
export async function resetCrawlShots(): Promise<void> {
  try {
    const count = await getCrawlShotCount();
    const keys = Array.from({ length: count }, (_, i) => shotKey(i));
    for (let i = 0; i < count; i++) keys.push(mshotKey(i)); // FR-EX-090 companions
    keys.push(COUNT_KEY);
    await chrome.storage.local.remove(keys);
  } catch {
    /* not in an extension context */
  }
}

/** FR-EX-090 — persist a mobile companion alongside desktop shot `seq`. */
export async function putCrawlMobileShot(seq: number, dataUrl: string): Promise<void> {
  try {
    await chrome.storage.local.set({ [mshotKey(seq)]: dataUrl });
  } catch {
    /* ignore — the desktop capture is what matters */
  }
}

/** FR-EX-090 — mobile companions, as [desktopSeq, dataUrl] pairs. Sparse: a state
 *  whose mobile shot was skipped simply has no entry. */
export async function getCrawlMobileShots(): Promise<[number, string][]> {
  try {
    const count = await getCrawlShotCount();
    if (count === 0) return [];
    const keys = Array.from({ length: count }, (_, i) => mshotKey(i));
    const got = await chrome.storage.local.get(keys);
    const out: [number, string][] = [];
    for (let i = 0; i < count; i++) {
      const v = got[mshotKey(i)];
      if (typeof v === "string") out.push([i, v]);
    }
    return out;
  } catch {
    return [];
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

/**
 * How many shots are stored. This — not a checkpointed counter — is the source
 * of truth for the next shot's sequence number when a crawl resumes after a
 * service-worker eviction (FR-EX-080): putCrawlShot advances the count as part
 * of the same write, so it can never disagree with the stored shots the way a
 * separately-checkpointed counter could (which would overwrite sc-crawl-shot-N
 * with a different state's image).
 */
export async function getCrawlShotCount(): Promise<number> {
  try {
    const meta = await chrome.storage.local.get(COUNT_KEY);
    return typeof meta[COUNT_KEY] === "number" ? (meta[COUNT_KEY] as number) : 0;
  } catch {
    return 0;
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
