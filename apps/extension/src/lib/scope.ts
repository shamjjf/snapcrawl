// Crawl scope (FR-EX-010/071) — is a URL inside the project's allowedDomains?
//
// A URL is in scope when its hostname equals an allowed domain or is a subdomain
// of one. Mirrors the backend's host-in-domains rule (packages/shared project.ts)
// so the extension and API agree on scope. Pure and unit-tested.

/** The lowercase hostname of a URL (no port, no trailing FQDN dot), or null. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/**
 * True when `url`'s host is one of `allowedDomains` or a subdomain of one. An
 * empty `allowedDomains` means "no restriction" (the caller decides the default).
 */
export function isInScope(url: string, allowedDomains: readonly string[]): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (allowedDomains.length === 0) return true;
  return allowedDomains.some((d) => {
    const dd = d.trim().toLowerCase().replace(/^\.+/, "");
    if (!dd) return false;
    return host === dd || host.endsWith(`.${dd}`);
  });
}

/**
 * Resolve the domains a run may touch: the configured list, or — when empty —
 * the base URL's host so a crawl is at least confined to its own site.
 */
export function effectiveAllowedDomains(
  allowedDomains: readonly string[] | undefined,
  baseUrl?: string,
): string[] {
  const list = (allowedDomains ?? []).map((d) => d.trim()).filter(Boolean);
  if (list.length > 0) return list;
  const host = baseUrl ? hostOf(baseUrl) : null;
  return host ? [host] : [];
}
