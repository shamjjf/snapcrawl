import { describe, it, expect } from "vitest";
import { discoverClickables } from "./discovery";

// FR-EX-020 / FR-EX-022 — finding logic. Visibility filtering is turned off here
// because test DOMs have no layout (getBoundingClientRect is 0). The visibility
// filter is covered separately in visibility.test.ts.
describe("discoverClickables (FR-EX-020)", () => {
  const opts = { filterVisible: false, cursorHeuristic: false } as const;

  it("finds links, buttons, inputs, and role/onclick elements", () => {
    document.body.innerHTML = `
      <a href="/a">link</a>
      <button>btn</button>
      <input type="submit" value="go" />
      <input type="button" value="go2" />
      <input type="text" value="not clickable" />
      <div role="button">rolebtn</div>
      <span onclick="void 0">clicky</span>
      <p>ignore me</p>
    `;
    const found = discoverClickables(opts);
    expect(found.length).toBe(6);
    expect(found.some((f) => f.tag === "a" && f.role === "link")).toBe(true);
    expect(found.some((f) => f.tag === "button" && f.role === "button")).toBe(true);
    expect(found.some((f) => f.tag === "div" && f.role === "button")).toBe(true);
    expect(found.some((f) => f.tag === "span")).toBe(true);
    expect(found.some((f) => f.text === "not clickable")).toBe(false);
  });

  it("de-duplicates an element matched by multiple rules", () => {
    document.body.innerHTML = `<button role="button" onclick="void 0">x</button>`;
    expect(discoverClickables(opts).length).toBe(1);
  });

  it("includes the cursor:pointer heuristic only when enabled", () => {
    document.body.innerHTML = `<div style="cursor:pointer">clicky div</div><div>plain</div>`;
    expect(discoverClickables({ filterVisible: false, cursorHeuristic: true }).length).toBe(1);
    expect(discoverClickables({ filterVisible: false, cursorHeuristic: false }).length).toBe(0);
  });

  it("recurses into open shadow DOM (FR-EX-022)", () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const host = document.getElementById("host")!;
    host.attachShadow({ mode: "open" }).innerHTML = `<button>in shadow</button>`;
    const found = discoverClickables(opts);
    expect(found.some((f) => f.tag === "button" && f.text === "in shadow")).toBe(true);
  });

  it("prefers id / data-testid / aria-label for the selector", () => {
    document.body.innerHTML = `
      <button id="save">Save</button>
      <button data-testid="cancel">Cancel</button>
      <button aria-label="Close dialog">x</button>
    `;
    const found = discoverClickables(opts);
    expect(found.find((f) => f.text === "Save")?.selector).toBe("#save");
    expect(found.find((f) => f.text === "Cancel")?.selector).toBe('[data-testid="cancel"]');
    expect(found.find((f) => f.text === "Close dialog")?.selector).toBe(
      'button[aria-label="Close dialog"]',
    );
  });

  it("collapses inherited-cursor descendants (button text is not its own target)", () => {
    // The inner span is 'clickable' only via inherited cursor:pointer.
    document.body.innerHTML = `<button style="cursor:pointer"><span style="cursor:pointer">Save</span></button>`;
    const found = discoverClickables({ filterVisible: false, cursorHeuristic: true });
    expect(found.length).toBe(1);
    expect(found[0]?.tag).toBe("button");
  });

  it("keeps a real nested control inside a clickable wrapper", () => {
    // A clickable row (div[onclick]) with a text span AND a real Delete button.
    document.body.innerHTML =
      `<div onclick="void 0" style="cursor:pointer">` +
      `<span style="cursor:pointer">Row</span><button>Delete</button></div>`;
    const found = discoverClickables({ filterVisible: false, cursorHeuristic: true });
    const tags = found.map((f) => f.tag).sort();
    expect(tags).toEqual(["button", "div"]); // span dropped, row + button kept
  });
});
