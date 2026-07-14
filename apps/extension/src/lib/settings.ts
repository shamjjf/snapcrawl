// Persisted extension settings (chrome.storage.local).
//
// Safe mode gates whether the crawler skips destructive actions (FR-EX-070) or
// clicks them too. Clicking them is an intended feature for testers on
// staging/dev apps who need to capture what happens AFTER a destructive action
// (e.g. the screen after a Delete).

const SAFE_MODE_KEY = "sc-safe-mode";

export async function getSafeMode(): Promise<boolean> {
  try {
    const r = await chrome.storage.local.get(SAFE_MODE_KEY);
    const v = r[SAFE_MODE_KEY];
    return typeof v === "boolean" ? v : true; // default ON (safe)
  } catch {
    return true;
  }
}

export async function setSafeMode(value: boolean): Promise<void> {
  try {
    await chrome.storage.local.set({ [SAFE_MODE_KEY]: value });
  } catch {
    /* not in an extension context (e.g. vite preview) */
  }
}
