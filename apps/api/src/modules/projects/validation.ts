import type { ErrorDetail } from "@snapcrawl/shared";

// Business-rule validation of a project's effective baseUrl + config on write
// (FR-BE-023). Zod (shared) already covered shape/types/numeric-ranges/URL
// syntax; this adds the cross-field + semantic rules and returns field-level
// details for the `{code,message,details[]}` envelope.

function hostOf(url: string): string | null {
  const m = /^[a-z][a-z\d+.-]*:\/\/([^/:?#]+)/i.exec(url);
  return m ? m[1].toLowerCase() : null;
}

function hostInDomains(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => {
    const dd = d.toLowerCase();
    return host === dd || host.endsWith(`.${dd}`);
  });
}

export interface ProjectConfigLike {
  allowedDomains?: string[];
  excludeUrlPatterns?: string[];
}

export function validateProjectConfig(baseUrl: string, config: ProjectConfigLike): ErrorDetail[] {
  const details: ErrorDetail[] = [];

  const domains = config.allowedDomains ?? [];
  if (domains.length === 0) {
    details.push({
      path: "config.allowedDomains",
      message: "At least one allowed domain is required.",
    });
  } else {
    const host = hostOf(baseUrl);
    if (host && !hostInDomains(host, domains)) {
      details.push({
        path: "config.allowedDomains",
        message: "allowedDomains must include the base URL's domain.",
      });
    }
  }

  (config.excludeUrlPatterns ?? []).forEach((pattern, i) => {
    try {
      new RegExp(pattern);
    } catch {
      details.push({
        path: `config.excludeUrlPatterns.${i}`,
        message: `Invalid regular expression: ${pattern}`,
      });
    }
  });

  return details;
}
