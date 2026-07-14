import type { ApiToken } from "@snapcrawl/shared";
import type { ApiTokenDoc } from "../../models/apiToken";

// Extension token helpers (FR-BE-060/061/063).

/** Whether a token may authenticate an /ext/* request (FR-BE-061). Pure so the
 *  auth middleware's core logic is unit-testable without a DB or the clock. */
export function tokenUsable(
  t: { revokedAt?: Date | null; expiresAt?: Date | null; scopes?: string[] },
  now: number,
): { ok: boolean; reason?: "revoked" | "expired" | "scope" } {
  if (t.revokedAt) return { ok: false, reason: "revoked" };
  if (t.expiresAt && t.expiresAt.getTime() < now) return { ok: false, reason: "expired" };
  if (!(t.scopes ?? []).includes("capture")) return { ok: false, reason: "scope" };
  return { ok: true };
}

/** Map a token document to the shared `ApiToken` shape — never the hash/raw (§8.2). */
export function serializeToken(t: ApiTokenDoc): ApiToken {
  return {
    id: String(t._id),
    name: t.name,
    scopes: (t.scopes ?? ["capture"]) as ApiToken["scopes"],
    lastUsedAt: t.lastUsedAt ?? null,
    expiresAt: t.expiresAt ?? null,
    revokedAt: t.revokedAt ?? null,
    createdAt: t.createdAt,
  };
}
