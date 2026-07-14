import { createHash, randomBytes } from "node:crypto";

// Personal extension tokens (FR-BE-060). The raw token is returned to the user
// exactly once on creation; only its SHA-256 hash is ever persisted.
const TOKEN_PREFIX = "sc_";

/** A high-entropy, URL-safe pairing token, e.g. `sc_xI3…`. */
export function generateRawToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** Deterministic SHA-256 hex digest — what we store and look up by. */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
