import type { Page } from "@snapcrawl/shared";

// Turn an over-fetched result set into the shared `{ items, nextCursor }`
// envelope (FR-BE-073). Query `limit + 1` rows: if more than `limit` came back
// there is another page, and the cursor is the last kept row's id.
export function buildPage<T, D extends { _id: unknown }>(
  docs: D[],
  limit: number,
  serialize: (doc: D) => T,
): Page<T> {
  const hasMore = docs.length > limit;
  const kept = hasMore ? docs.slice(0, limit) : docs;
  const nextCursor = hasMore ? String(kept[kept.length - 1]._id) : null;
  return { items: kept.map(serialize), nextCursor };
}
