// Pairing + project storage (FR-EX-001/002).
//
// The extension pairs with the backend by storing { backendUrl, token } in
// chrome.storage.local. The token is a revocable bearer credential and the only
// secret the extension holds (C-05) — NEVER log it. The actual network call
// lives in the service worker (host_permissions bypass CORS); this module owns
// the storage shape and the pure URL/response helpers it shares with the SW.

import type { Project } from "@snapcrawl/shared";

export interface Pairing {
  backendUrl: string;
  token: string;
}

/** Result of an /ext/projects call — shared by pair (FR-EX-001) + refresh (FR-EX-002). */
export type ProjectsResult =
  | { ok: true; projects: Project[] }
  | { ok: false; status?: number; code?: string; message: string };

const PAIRING_KEY = "sc-pairing";
const PROJECTS_KEY = "sc-projects";
const PROJECT_ID_KEY = "sc-project-id";

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** Trim and drop trailing slashes from a user-entered backend URL. */
export function normalizeBackendUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** The extension projects endpoint for a given backend base URL. */
export function extProjectsUrl(backendUrl: string): string {
  return `${normalizeBackendUrl(backendUrl)}/api/v1/ext/projects`;
}

/**
 * Map an HTTP status + parsed JSON body to a ProjectsResult. 200 ⇒ the `items`
 * array; 401/403 ⇒ a clear re-pairing message from the error envelope
 * `{ code, message }` (FR-BE-070); other non-2xx ⇒ a generic message. Pure.
 */
export function parseProjectsResponse(status: number, body: unknown): ProjectsResult {
  const env = (body ?? {}) as { code?: string; message?: string; items?: unknown };
  if (status === 200) {
    return { ok: true, projects: Array.isArray(env.items) ? (env.items as Project[]) : [] };
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      status,
      code: env.code,
      message:
        env.message ||
        "Token rejected — generate a new token in the admin panel and re-pair.",
    };
  }
  return {
    ok: false,
    status,
    code: env.code,
    message: env.message || `Backend error (${status}).`,
  };
}

// ── Storage (chrome.storage.local) ──────────────────────────────────────────

export async function getPairing(): Promise<Pairing | null> {
  try {
    const r = await chrome.storage.local.get(PAIRING_KEY);
    const v = r[PAIRING_KEY] as Partial<Pairing> | undefined;
    if (v && typeof v.backendUrl === "string" && typeof v.token === "string") {
      return { backendUrl: v.backendUrl, token: v.token };
    }
  } catch {
    /* not in an extension context */
  }
  return null;
}

export async function setPairing(p: Pairing): Promise<void> {
  try {
    await chrome.storage.local.set({ [PAIRING_KEY]: p });
  } catch {
    /* ignore */
  }
}

export async function clearPairing(): Promise<void> {
  try {
    await chrome.storage.local.remove([PAIRING_KEY, PROJECTS_KEY, PROJECT_ID_KEY]);
  } catch {
    /* ignore */
  }
}

export async function getCachedProjects(): Promise<Project[]> {
  try {
    const r = await chrome.storage.local.get(PROJECTS_KEY);
    return Array.isArray(r[PROJECTS_KEY]) ? (r[PROJECTS_KEY] as Project[]) : [];
  } catch {
    return [];
  }
}

export async function setCachedProjects(projects: Project[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [PROJECTS_KEY]: projects });
  } catch {
    /* ignore */
  }
}

export async function getSelectedProjectId(): Promise<string | null> {
  try {
    const r = await chrome.storage.local.get(PROJECT_ID_KEY);
    return typeof r[PROJECT_ID_KEY] === "string" ? r[PROJECT_ID_KEY] : null;
  } catch {
    return null;
  }
}

export async function setSelectedProjectId(id: string): Promise<void> {
  try {
    await chrome.storage.local.set({ [PROJECT_ID_KEY]: id });
  } catch {
    /* ignore */
  }
}
