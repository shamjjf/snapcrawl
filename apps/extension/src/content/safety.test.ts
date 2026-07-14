import { describe, it, expect } from "vitest";
import { isDestructive } from "./safety";

const BL = [
  "delete",
  "remove",
  "logout",
  "log out",
  "sign out",
  "pay",
  "buy",
  "checkout",
  "send",
];

function el(html: string): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild!;
}

// FR-EX-070
describe("isDestructive (FR-EX-070)", () => {
  it("blocks exact destructive text", () => {
    expect(isDestructive(el(`<button>Delete</button>`), BL)).toBe(true);
    expect(isDestructive(el(`<button>Checkout</button>`), BL)).toBe(true);
  });

  it("blocks a destructive word inside longer text", () => {
    expect(isDestructive(el(`<button>Delete account</button>`), BL)).toBe(true);
    expect(isDestructive(el(`<a href="#">Log out of SnapCrawl</a>`), BL)).toBe(true);
  });

  it("checks aria-label, title, and input value", () => {
    expect(isDestructive(el(`<button aria-label="Remove item">x</button>`), BL)).toBe(true);
    expect(isDestructive(el(`<button title="Sign out">x</button>`), BL)).toBe(true);
    expect(isDestructive(el(`<input type="submit" value="Pay now" />`), BL)).toBe(true);
  });

  it("is case-insensitive and trims/collapses whitespace", () => {
    expect(isDestructive(el(`<button>  DELETE  </button>`), BL)).toBe(true);
    expect(isDestructive(el(`<button>Log   out</button>`), BL)).toBe(true);
  });

  it("does not block safe words or partial matches", () => {
    expect(isDestructive(el(`<button>Save</button>`), BL)).toBe(false);
    expect(isDestructive(el(`<button>Resend</button>`), BL)).toBe(false); // not "send"
    expect(isDestructive(el(`<button>Buyer profile</button>`), BL)).toBe(false); // not "buy"
  });

  it("blocks nothing when the blocklist is empty", () => {
    expect(isDestructive(el(`<button>Delete</button>`), [])).toBe(false);
  });
});
