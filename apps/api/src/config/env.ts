// Process/environment policy for the API. Deliberately functions rather than
// import-time constants so the value is read at call time (a module-scope const
// is frozen at import and can't be exercised by a test).

/** The deployment environment. Unset ⇒ "development". */
export function nodeEnv(): string {
  return process.env.NODE_ENV ?? "development";
}

export function isProd(): boolean {
  return nodeEnv() === "production";
}

/** Env flags are opt-in and exact: only the literal "true" enables one, so
 *  SEED_ADMIN=false / 0 / "" can never switch a guard on by truthiness. */
export function envFlag(name: string): boolean {
  return (process.env[name] ?? "").trim().toLowerCase() === "true";
}
