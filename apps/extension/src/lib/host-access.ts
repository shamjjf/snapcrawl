// Runtime host access for the current-tab crawl (FR-EX-011/015, C-07).
//
// The crawl runs from the service worker, and its executeScript into the crawl
// tab needs a persistent Chrome host permission for the site — the popup's
// one-off `activeTab` grant doesn't extend to the SW. We request that access at
// runtime from `optional_host_permissions` (never widening static
// host_permissions). The project's `allowedDomains` is the crawl SCOPE — a
// separate system that grants no Chrome host access.

import { hostOf } from "./scope";

/** Normalise a host/domain: lowercase, drop leading/trailing dots. */
function normHost(h: string): string {
  return h.trim().toLowerCase().replace(/^\.+/, "").replace(/\.$/, "");
}

/**
 * Match patterns to request for a crawl: the start URL's host plus every scope
 * domain, each covering the host AND its subdomains (matching `isInScope`). Pure.
 */
export function crawlOrigins(startUrl: string, allowedDomains: readonly string[]): string[] {
  const origins = new Set<string>();
  const add = (host: string | null): void => {
    const h = host ? normHost(host) : "";
    if (!h) return;
    origins.add(`*://${h}/*`);
    origins.add(`*://*.${h}/*`);
  };
  add(hostOf(startUrl));
  for (const d of allowedDomains) add(d);
  return [...origins];
}

const RESTRICTED_SCHEME =
  /^(chrome|chrome-extension|chrome-search|chrome-untrusted|edge|about|devtools|view-source|moz-extension):/i;
const WEB_STORE = /^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;

/**
 * The right error when content-script injection fails. Only http/https pages are
 * crawlable: genuinely restricted schemes keep the "restricted page" message;
 * a normal site means host access (or injection) was blocked — never blame
 * chrome:// for a real site. Pure.
 */
export function injectionErrorMessage(url: string): string {
  if (!url) return "SnapCrawl couldn't access this page (permission or injection blocked).";
  if (!/^https?:\/\//i.test(url) || WEB_STORE.test(url) || RESTRICTED_SCHEME.test(url)) {
    return "This is a restricted page (chrome://, extensions, or the Chrome Web Store) — open a normal website.";
  }
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* ignore */
  }
  return `SnapCrawl couldn't access ${host || "this site"} (permission or injection blocked). Grant access and try again.`;
}

/**
 * Request host access for a crawl. MUST be called from a user gesture (the popup
 * Start handler) — chrome.permissions.request silently fails without one, and the
 * service worker has no gesture. `request()` resolves true without prompting when
 * access is already granted, so no separate `contains()` pre-check is needed
 * (which would risk losing the gesture to an extra await).
 */
export function requestCrawlAccess(
  startUrl: string,
  allowedDomains: readonly string[],
): Promise<boolean> {
  const origins = crawlOrigins(startUrl, allowedDomains);
  if (origins.length === 0) return Promise.resolve(true);
  return chrome.permissions.request({ origins });
}
