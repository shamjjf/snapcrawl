import { afterEach, describe, expect, it, vi } from "vitest";
import { isInteractable } from "./visibility";

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

function mockRect(el: Element, rect: Partial<DOMRect>): void {
  const full = {
    x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0,
    toJSON: () => ({}), ...rect,
  } as DOMRect;
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue(full);
}

// FR-EX-021
describe("isInteractable (FR-EX-021)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects a detached element", () => {
    expect(isInteractable(document.createElement("button"))).toBe(false);
  });

  it("rejects a disabled control", () => {
    const el = mount(`<button disabled>x</button>`);
    mockRect(el, { width: 80, height: 24, left: 10, top: 10 });
    expect(isInteractable(el)).toBe(false);
  });

  it("rejects aria-disabled", () => {
    const el = mount(`<div role="button" aria-disabled="true">x</div>`);
    mockRect(el, { width: 80, height: 24, left: 10, top: 10 });
    expect(isInteractable(el)).toBe(false);
  });

  it("rejects display:none and visibility:hidden", () => {
    expect(isInteractable(mount(`<button style="display:none">x</button>`))).toBe(false);
    expect(isInteractable(mount(`<button style="visibility:hidden">x</button>`))).toBe(false);
  });

  it("rejects zero-size elements", () => {
    expect(isInteractable(mount(`<button>x</button>`))).toBe(false); // no rect mock → 0×0
  });

  it("accepts a visible, hit-testable element", () => {
    const el = mount(`<button>x</button>`);
    mockRect(el, { width: 80, height: 24, left: 10, top: 10, right: 90, bottom: 34 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(el);
    expect(isInteractable(el)).toBe(true);
  });

  it("accepts when the centre hits a child (button > span)", () => {
    const el = mount(`<button><span>x</span></button>`);
    const span = el.querySelector("span")!;
    mockRect(el, { width: 80, height: 24, left: 10, top: 10, right: 90, bottom: 34 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(span);
    expect(isInteractable(el)).toBe(true); // el.contains(span)
  });

  it("rejects when covered by an unrelated element", () => {
    const el = mount(`<button>x</button>`);
    const overlay = document.body.appendChild(document.createElement("div"));
    mockRect(el, { width: 80, height: 24, left: 10, top: 10, right: 90, bottom: 34 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(overlay);
    expect(isInteractable(el)).toBe(false);
  });
});
