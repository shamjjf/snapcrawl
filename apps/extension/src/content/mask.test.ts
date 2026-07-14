import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMasks, removeMasks } from "./crawl-inject";

// happy-dom has no layout engine, so getBoundingClientRect is mocked (as in
// visibility.test.ts). Real overlay geometry is verified in the browser.
function rect(w = 100, h = 20, left = 5, top = 10): DOMRect {
  return {
    width: w,
    height: h,
    left,
    top,
    right: left + w,
    bottom: top + h,
    x: left,
    y: top,
    toJSON() {},
  } as DOMRect;
}

afterEach(() => {
  document.body.innerHTML = "";
  document.querySelectorAll("[data-sc-mask]").forEach((n) => n.remove());
  vi.restoreAllMocks();
});

describe("mask overlays (FR-EX-053)", () => {
  it("covers every matching element with an opaque overlay", () => {
    document.body.innerHTML =
      '<span class="pii">a@b.com</span><span class="pii">c@d.com</span><span>ok</span>';
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => rect());

    const { masked } = applyMasks({ selectors: [".pii"] });
    expect(masked).toBe(2);

    const overlays = document.querySelectorAll("[data-sc-mask]");
    expect(overlays.length).toBe(2);
    const o = overlays[0] as HTMLElement;
    expect(o.style.opacity).toBe("1");
    expect(o.style.pointerEvents).toBe("none");
    expect(o.style.position).toBe("fixed");
  });

  it("removeMasks clears every overlay", () => {
    document.body.innerHTML = '<div class="pii">x</div>';
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => rect());
    applyMasks({ selectors: [".pii"] });
    expect(document.querySelectorAll("[data-sc-mask]").length).toBe(1);
    removeMasks();
    expect(document.querySelectorAll("[data-sc-mask]").length).toBe(0);
  });

  it("re-applying replaces old overlays (no accumulation)", () => {
    document.body.innerHTML = '<div class="pii">x</div>';
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => rect());
    applyMasks({ selectors: [".pii"] });
    applyMasks({ selectors: [".pii"] });
    expect(document.querySelectorAll("[data-sc-mask]").length).toBe(1);
  });

  it("no selectors ⇒ nothing masked", () => {
    expect(applyMasks({ selectors: [] }).masked).toBe(0);
  });

  it("an invalid selector is skipped; valid ones still apply", () => {
    document.body.innerHTML = '<div class="pii">x</div>';
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => rect());
    const { masked } = applyMasks({ selectors: ["::::bad", ".pii"] });
    expect(masked).toBe(1);
  });

  it("skips zero-size (hidden) matches", () => {
    document.body.innerHTML = '<div class="pii">x</div>';
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => rect(0, 0));
    expect(applyMasks({ selectors: [".pii"] }).masked).toBe(0);
  });
});
