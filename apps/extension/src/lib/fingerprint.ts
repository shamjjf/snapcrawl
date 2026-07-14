// State fingerprinting (FR-EX-040) — the keystone that lets the crawl recognise
// "have I already seen this UI state?".
//
//   fingerprint = SHA-256( normalisedURL + "\n" + structural DOM signature )
//
// URL normalisation (this file, pure & unit-tested): sort query params, drop
// volatile params (utm_*, click ids, cache-busters, timestamps), keep the hash
// only when the app is hash-routed (the fragment is the route), else drop it.
//
// The structural DOM signature is extracted in the page by
// `extractStateSignature` in content/crawl-inject.ts (DOM-only, no crypto — many
// staging apps run over plain http where crypto.subtle is unavailable). Hashing
// happens here, in the extension's secure context.

/** Query params that never identify a distinct state — dropped before hashing. */
const VOLATILE_EXACT = new Set([
  "t",
  "ts",
  "_",
  "cb",
  "cache",
  "nocache",
  "timestamp",
  "time",
  "fbclid",
  "gclid",
  "dclid",
  "_ga",
  "_gid",
  "_gl",
  "mc_eid",
  "mc_cid",
  "igshid",
  "ref",
]);

function isVolatileParam(key: string): boolean {
  const k = key.toLowerCase();
  return k.startsWith("utm_") || VOLATILE_EXACT.has(k);
}

/** A hash `#/…` or `#!/…` fragment is an SPA route, not a scroll anchor. */
function isRouteHash(hash: string): boolean {
  return /^#!?\//.test(hash);
}

export interface NormalizeUrlOptions {
  /** Force treating the fragment as a route even if it doesn't look like one. */
  hashRouted?: boolean;
}

/**
 * Canonicalise a URL for fingerprinting. Deterministic and pure.
 * Returns the input trimmed if it can't be parsed as a URL.
 */
export function normalizeUrl(rawUrl: string, opts: NormalizeUrlOptions = {}): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl.trim();
  }

  const params = [...u.searchParams.entries()]
    .filter(([k]) => !isVolatileParam(k))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const search = params.length ? "?" + params.map(([k, v]) => `${k}=${v}`).join("&") : "";

  const keepHash = u.hash.length > 1 && (opts.hashRouted || isRouteHash(u.hash));
  const hash = keepHash ? u.hash : "";

  let path = u.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  return `${u.origin}${path}${search}${hash}`;
}

/** SHA-256 of a string → lowercase hex. Uses the Web Crypto API. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * State fingerprint (FR-EX-040): SHA-256 of the normalised URL plus the
 * structural DOM signature. Same URL + same structure ⇒ same fingerprint;
 * an opened modal / switched tab changes the signature ⇒ new fingerprint
 * (FR-EX-043).
 */
export async function computeFingerprint(
  url: string,
  domSignature: string,
  opts: NormalizeUrlOptions = {},
): Promise<string> {
  return sha256Hex(normalizeUrl(url, opts) + "\n" + domSignature);
}
