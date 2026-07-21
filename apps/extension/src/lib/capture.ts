// Screenshot capture + ZIP export (FR-EX-050). Captures the visible tab as PNG,
// keeps a small persisted collection in chrome.storage.local, and bundles them
// into one downloadable ZIP. This is a manual/dev capability for now; the crawl
// engine will capture each unique state automatically later.

import { buildZip, dataUrlToBytes } from "./zip";

const CAPTURES_KEY = "sc-captures";
const MAX_CAPTURES = 12;

/** PNG data URL of the active tab's visible viewport (needs activeTab / host). */
export function captureVisibleTab(): Promise<string> {
  return chrome.tabs.captureVisibleTab({ format: "png" });
}

export async function getCaptures(): Promise<string[]> {
  try {
    const r = await chrome.storage.local.get(CAPTURES_KEY);
    const v = r[CAPTURES_KEY];
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

/** Capture the visible tab and append it to the stored collection. */
export async function captureAndStore(): Promise<number> {
  const dataUrl = await captureVisibleTab();
  const list = await getCaptures();
  const next = [...list, dataUrl].slice(-MAX_CAPTURES);
  await chrome.storage.local.set({ [CAPTURES_KEY]: next });
  return next.length;
}

export async function clearCaptures(): Promise<void> {
  try {
    await chrome.storage.local.set({ [CAPTURES_KEY]: [] });
  } catch {
    /* ignore */
  }
}

/** Bundle a list of PNG data URLs into a ZIP and download it.
 *
 *  `mobile` (FR-EX-090) are companion shots keyed by the DESKTOP index they
 *  belong to, so a phone shot lands next to its desktop twin as
 *  screen-004-mobile.png. Sparse by design: a state whose mobile shot was
 *  skipped simply has no entry. */
export async function downloadDataUrlsZip(
  list: string[],
  filename = "snapcrawl-crawl.zip",
  saveAs = false,
  mobile: [number, string][] = [],
): Promise<void> {
  if (list.length === 0) return;

  const pad = (i: number) => String(i + 1).padStart(3, "0");
  const entries = list.map((dataUrl, i) => ({
    name: `screen-${pad(i)}.png`,
    data: dataUrlToBytes(dataUrl),
  }));
  for (const [seq, dataUrl] of mobile) {
    entries.push({ name: `screen-${pad(seq)}-mobile.png`, data: dataUrlToBytes(dataUrl) });
  }
  const bytes = buildZip(entries);
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename, saveAs });
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

/** Bundle all stored (dev) captures into a ZIP and download it. */
export async function downloadCapturesZip(): Promise<void> {
  const list = await getCaptures();
  await downloadDataUrlsZip(list, "snapcrawl-screenshots.zip", true);
}
