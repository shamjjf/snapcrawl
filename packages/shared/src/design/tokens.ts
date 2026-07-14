/**
 * Typed accessors for the SnapCrawl design tokens.
 *
 * - `token.*` returns CSS `var(--…)` references — theme-aware at runtime. Use
 *   these in inline styles / styled components so light↔dark just works.
 * - `palette.*` returns raw hex primitives — use ONLY where a real color string
 *   is required (canvas, react-flow edge strokes, chart libraries).
 *
 * The values here mirror packages/shared/src/design/tokens.css. That CSS file
 * is the source of truth for what the browser actually renders; import it once
 * per app. See docs/DESIGN.md.
 */

/** Raw primitive hex values. Prefer `token.*` unless a literal color is needed. */
export const palette = {
  az: {
    50: "#ecf5ff",
    100: "#d6e9ff",
    200: "#afd3ff",
    300: "#93c5fd",
    400: "#3d93f2",
    500: "#1478e0",
    600: "#0b6bcb",
    700: "#0a57a6",
    800: "#0c4884",
    900: "#0e3a69",
    950: "#0b2545",
  },
  slate: {
    0: "#ffffff",
    50: "#f8fafc",
    100: "#f1f5f9",
    200: "#e2e8f0",
    300: "#cbd5e1",
    400: "#94a3b8",
    500: "#64748b",
    600: "#475569",
    700: "#334155",
    800: "#1e293b",
    900: "#0f172a",
    950: "#0b1220",
  },
  green: { 50: "#f0fdf4", 300: "#86efac", 400: "#4ade80", 600: "#16a34a", 700: "#15803d", 950: "#052e16" },
  amber: { 50: "#fffbeb", 300: "#fcd34d", 400: "#fbbf24", 600: "#d97706", 700: "#b45309", 950: "#2a1a05" },
  red: { 50: "#fef2f2", 300: "#fca5a5", 400: "#f87171", 600: "#dc2626", 700: "#b91c1c", 950: "#2a0e0e" },
  teal: { 400: "#2dd4bf", 600: "#0d9488" },
} as const;

/** Return a `var(--name)` reference for any design token custom property. */
export function cssVar(name: string, fallback?: string): string {
  return fallback ? `var(--${name}, ${fallback})` : `var(--${name})`;
}

/** Theme-aware semantic tokens as CSS var() references. */
export const token = {
  bg: cssVar("color-bg"),
  surface: cssVar("color-surface"),
  surface2: cssVar("color-surface-2"),
  surface3: cssVar("color-surface-3"),
  border: cssVar("color-border"),
  borderStrong: cssVar("color-border-strong"),
  borderInteractive: cssVar("color-border-interactive"),
  text: cssVar("color-text"),
  textMuted: cssVar("color-text-muted"),
  textSubtle: cssVar("color-text-subtle"),
  textInverse: cssVar("color-text-inverse"),
  primary: cssVar("color-primary"),
  primaryHover: cssVar("color-primary-hover"),
  primaryActive: cssVar("color-primary-active"),
  onPrimary: cssVar("color-on-primary"),
  primaryText: cssVar("color-primary-text"),
  focusRing: cssVar("color-focus-ring"),
  link: cssVar("color-link"),
  success: cssVar("color-success"),
  warning: cssVar("color-warning"),
  danger: cssVar("color-danger"),
  dangerEmphasis: cssVar("color-danger-emphasis"),
  onDanger: cssVar("color-on-danger"),
  info: cssVar("color-info"),
  accent: cssVar("color-accent"),
  fontSans: cssVar("font-sans"),
  fontMono: cssVar("font-mono"),
  radiusMd: cssVar("radius-md"),
  radiusLg: cssVar("radius-lg"),
  shadowSm: cssVar("shadow-sm"),
  shadowMd: cssVar("shadow-md"),
} as const;

/** The six crawl session statuses (mirror @snapcrawl/shared session schema). */
export type SessionStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/** Chip token bundle (bg / text / dot) for a given session status. */
export function statusTokens(status: SessionStatus) {
  return {
    bg: cssVar(`status-${status}-bg`),
    text: cssVar(`status-${status}-text`),
    dot: cssVar(`status-${status}-dot`),
  };
}
