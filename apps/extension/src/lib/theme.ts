// Theme helper — light/dark/system, backed by the design tokens' data-theme
// mechanism. GUI-only (localStorage, shared across the extension's pages).

export type ThemeMode = "system" | "light" | "dark";

const KEY = "sc-theme";

export function getTheme(): ThemeMode {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

/** Stamp (or clear) data-theme on <html>. "system" falls back to the OS. */
export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
}

export function setTheme(mode: ThemeMode): void {
  localStorage.setItem(KEY, mode);
  applyTheme(mode);
}

/** Resolve to the concrete theme in effect, expanding "system" via the OS. */
export function resolveTheme(mode: ThemeMode = getTheme()): "light" | "dark" {
  if (mode === "light" || mode === "dark") return mode;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}
