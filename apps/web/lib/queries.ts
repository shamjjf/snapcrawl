// TanStack Query hooks (SRS §3.3). One thin layer over lib/api — components
// never touch fetch or the token directly. Each hook is fixture/live agnostic:
// the api function it calls handles the toggle, so nothing here changes when the
// backend ships.

import { useEffect } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { sessionSchema } from "@snapcrawl/shared";
import type {
  ProjectCreate,
  ProjectUpdate,
  TokenCreate,
  UserCreate,
  UserUpdate,
} from "@snapcrawl/shared";
import { getToken } from "./auth";
import * as api from "./api";

function token(): string {
  return getToken() ?? "";
}

type SessionFilters = { status?: string; from?: string; to?: string };
type ScreenFilters = { url?: string; depth?: number; duplicate?: boolean };

const keys = {
  projects: (search: string) => ["projects", { search }] as const,
  project: (id: string) => ["project", id] as const,
  tokens: () => ["tokens"] as const,
  users: (search: string) => ["users", { search }] as const,
  sessions: (projectId: string, f: SessionFilters) => ["sessions", projectId, f] as const,
  session: (id: string) => ["session", id] as const,
  sessionLogs: (id: string) => ["session-logs", id] as const,
  screens: (sessionId: string, f: ScreenFilters) => ["screens", sessionId, f] as const,
};

/* ── Projects ────────────────────────────────────────────────────── */

export function useProjects(search: string) {
  return useInfiniteQuery({
    queryKey: keys.projects(search),
    queryFn: ({ pageParam }) =>
      api.listProjects(token(), { search, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useProject(id: string) {
  return useQuery({
    queryKey: keys.project(id),
    queryFn: () => api.getProject(token(), id),
    enabled: Boolean(id),
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ProjectCreate) => api.createProject(token(), input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

export function useUpdateProject(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ProjectUpdate) => api.updateProject(token(), id, input),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["projects"] }),
        qc.invalidateQueries({ queryKey: keys.project(id) }),
      ]),
  });
}

export function useArchiveProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.archiveProject(token(), id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

/* ── Extension tokens ────────────────────────────────────────────── */

export function useTokens() {
  return useQuery({
    queryKey: keys.tokens(),
    queryFn: () => api.listTokens(token()),
  });
}

export function useCreateToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TokenCreate) => api.createToken(token(), input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.tokens() }),
  });
}

export function useRevokeToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.revokeToken(token(), id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.tokens() }),
  });
}

/* ── Users (FR-AP-060) ───────────────────────────────────────────── */

export function useUsers(search: string) {
  return useInfiniteQuery({
    queryKey: keys.users(search),
    queryFn: ({ pageParam }) => api.listUsers(token(), { search, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UserCreate) => api.createUser(token(), input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UserUpdate }) =>
      api.updateUser(token(), id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

/* ── Sessions + screens (FR-AP-030/031/040/041) ──────────────────── */

export function useSessions(projectId: string, filters: SessionFilters) {
  return useInfiniteQuery({
    queryKey: keys.sessions(projectId, filters),
    queryFn: ({ pageParam }) =>
      api.listSessions(token(), projectId, { ...filters, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(projectId),
  });
}

const ACTIVE_STATUSES = new Set(["pending", "running", "paused"]);

export function useSession(id: string) {
  return useQuery({
    queryKey: keys.session(id),
    queryFn: () => api.getSession(token(), id),
    enabled: Boolean(id),
    // 5 s polling fallback while the session is active (FR-AP-032); stops once
    // it reaches a terminal state.
    refetchInterval: (query) =>
      query.state.data && ACTIVE_STATUSES.has(query.state.data.status) ? 5000 : false,
  });
}

/** Live updates via SSE (FR-AP-032): each event carries the full session, so we
 *  write it straight into the cache (no reload). The 5 s polling above is the
 *  fallback. No-op in fixture mode (no SSE server) and once the session ends. */
export function useSessionEvents(id: string, active: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!active || !id || api.USE_FIXTURES || typeof EventSource === "undefined") return;
    const es = new EventSource(api.sessionEventsUrl(id, token()));
    // The backend sends NAMED events (snapshot/stats/status) whose data is the
    // serialized session, so es.onmessage never fires — listen per type.
    const onEvent = (e: MessageEvent) => {
      try {
        const parsed = sessionSchema.safeParse(JSON.parse(e.data));
        if (parsed.success) {
          qc.setQueryData(keys.session(id), parsed.data);
          return;
        }
      } catch {
        /* malformed — fall through to a refetch */
      }
      void qc.invalidateQueries({ queryKey: keys.session(id) });
    };
    for (const type of ["snapshot", "stats", "status"]) {
      es.addEventListener(type, onEvent as EventListener);
    }
    es.onerror = () => es.close(); // fall back to the 5 s polling
    return () => es.close();
  }, [id, active, qc]);
}

export function useSessionGraph(id: string) {
  return useQuery({
    queryKey: ["session-graph", id],
    queryFn: () => api.getSessionGraph(token(), id),
    enabled: Boolean(id),
  });
}

export function useScreen(id: string) {
  return useQuery({
    queryKey: ["screen", id],
    queryFn: () => api.getScreen(token(), id),
    enabled: Boolean(id),
  });
}

export function useCancelSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.cancelSession(token(), id),
    onSuccess: (s) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.session(s.id) }),
        qc.invalidateQueries({ queryKey: ["sessions"] }),
      ]),
  });
}

export function useSessionLogs(id: string) {
  return useInfiniteQuery({
    queryKey: keys.sessionLogs(id),
    queryFn: ({ pageParam }) => api.listSessionLogs(token(), id, { cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(id),
  });
}

export function useScreens(sessionId: string, filters: ScreenFilters) {
  return useInfiniteQuery({
    queryKey: keys.screens(sessionId, filters),
    queryFn: ({ pageParam }) =>
      api.listScreens(token(), sessionId, { ...filters, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(sessionId),
  });
}
