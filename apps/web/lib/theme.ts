// Theme helper for the admin panel — light/dark/system via the design tokens'
// data-theme mechanism. Client-only (localStorage / matchMedia).

export type ThemeMode = "system" | "light" | "dark";

const KEY = "sc-theme";

export function getTheme(): ThemeMode {
  if (typeof localStorage === "undefined") return "system";
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

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
