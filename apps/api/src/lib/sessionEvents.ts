import { EventEmitter } from "node:events";
import type { SessionEvent } from "@snapcrawl/shared";

// In-process pub/sub for live session monitoring (FR-BE-036). Publishers (the
// ext PATCH handler, cancel, and the stale sweep) emit; the SSE endpoint
// subscribes per session id. Single-instance only — a horizontally-scaled
// deployment needs Redis pub/sub (NFR-004).
const bus = new EventEmitter();
// Many panel viewers may watch the same session; don't warn about listeners.
bus.setMaxListeners(0);

export function publishSessionEvent(sessionId: string, event: SessionEvent): void {
  bus.emit(sessionId, event);
}

/** Subscribe to a session's events; returns an unsubscribe function. */
export function subscribeSessionEvents(
  sessionId: string,
  listener: (event: SessionEvent) => void,
): () => void {
  bus.on(sessionId, listener);
  return () => bus.off(sessionId, listener);
}

/** Active subscriber count for a session — used to assert the SSE handler
 *  tears subscriptions down (no leak on disconnect). */
export function sessionListenerCount(sessionId: string): number {
  return bus.listenerCount(sessionId);
}
