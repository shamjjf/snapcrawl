// Default destructive-text blocklist (FR-BE-022). The crawler must never click
// an element whose visible text / aria-label / title / value matches one of
// these (FR-EX-070). Editable per project; this is the default.
export const DEFAULT_DESTRUCTIVE_BLOCKLIST: readonly string[] = [
  "delete",
  "remove",
  "logout",
  "log out",
  "sign out",
  "pay",
  "buy",
  "purchase",
  "checkout",
  "submit order",
  "confirm order",
  "deactivate",
  "unsubscribe",
  "send",
];
