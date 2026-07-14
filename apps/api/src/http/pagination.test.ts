import { describe, expect, it } from "vitest";
import { buildPage } from "./pagination";

const docs = (n: number) => Array.from({ length: n }, (_, i) => ({ _id: `id${i}`, v: i }));
const id = (d: { _id: unknown }) => d._id as string;

// FR-BE-073 — bounded lists with the shared { items, nextCursor } envelope.
describe("cursor page envelope (FR-BE-073)", () => {
  it("emits nextCursor = last kept id when there is another page", () => {
    // over-fetched limit + 1 (4 rows for limit 3)
    const page = buildPage(docs(4), 3, id);
    expect(page.items).toEqual(["id0", "id1", "id2"]);
    expect(page.nextCursor).toBe("id2");
  });

  it("emits nextCursor = null on the last page", () => {
    const page = buildPage(docs(2), 3, id);
    expect(page.items).toEqual(["id0", "id1"]);
    expect(page.nextCursor).toBeNull();
  });

  it("handles an empty result set", () => {
    expect(buildPage(docs(0), 3, id)).toEqual({ items: [], nextCursor: null });
  });
});
