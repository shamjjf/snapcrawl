import { afterEach, describe, expect, it } from "vitest";
import { clickCandidate, installNetworkCounter } from "./crawl-inject";

// happy-dom has no PointerEvent, so an allowed click's dispatch may report
// {ok:false, reason:"dispatch"} — we therefore assert the SCOPE DECISION (was it
// rejected as off-scope?) rather than the full click outcome. The off-scope
// rejection and target rewrite both happen BEFORE dispatch, so they're exact.
afterEach(() => {
  document.body.innerHTML = "";
  (window as unknown as { __scNetPatched?: boolean }).__scNetPatched = undefined;
});

function link(href: string, attrs = ""): void {
  document.body.innerHTML = `<a data-sc-idx="0" href="${href}" ${attrs}>go</a>`;
}

describe("clickCandidate — off-scope link rejection (FR-EX-010/071)", () => {
  it("rejects a link that leaves the allowed domains", () => {
    link("https://evil.example/x");
    expect(clickCandidate({ idx: 0, allowedDomains: ["myapp.test"] })).toEqual({
      ok: false,
      reason: "off-scope",
    });
  });

  it("does NOT reject an in-scope subdomain link", () => {
    link("https://app.myapp.test/x");
    expect(clickCandidate({ idx: 0, allowedDomains: ["myapp.test"] }).reason).not.toBe("off-scope");
  });

  it("does NOT reject any link when the scope is empty (unrestricted)", () => {
    link("https://anywhere.test/x");
    expect(clickCandidate({ idx: 0, allowedDomains: [] }).reason).not.toBe("off-scope");
  });

  it("does NOT reject a non-navigational javascript: link", () => {
    link("javascript:void(0)");
    expect(clickCandidate({ idx: 0, allowedDomains: ["myapp.test"] }).reason).not.toBe("off-scope");
  });

  it("rejects a lookalike suffix domain (not a real subdomain)", () => {
    link("https://notmyapp.test/x");
    expect(clickCandidate({ idx: 0, allowedDomains: ["myapp.test"] })).toEqual({
      ok: false,
      reason: "off-scope",
    });
  });

  it("does NOT reject a same-page hash link (stays on the in-scope current host)", () => {
    link("#section");
    const host = window.location.hostname; // a #hash resolves to the current page's host
    expect(clickCandidate({ idx: 0, allowedDomains: [host] }).reason).not.toBe("off-scope");
  });

  it("returns 'gone' when the element isn't present", () => {
    expect(clickCandidate({ idx: 99, allowedDomains: ["myapp.test"] })).toEqual({
      ok: false,
      reason: "gone",
    });
  });
});

describe("clickCandidate — target=_blank neutralization (FR-EX-072)", () => {
  it("rewrites target=_blank to _self before clicking", () => {
    link("https://app.myapp.test/x", 'target="_blank"');
    clickCandidate({ idx: 0, allowedDomains: ["myapp.test"] });
    expect(document.querySelector("a")?.getAttribute("target")).toBe("_self");
  });
});

describe("installNetworkCounter — window.open neutralization (FR-EX-072)", () => {
  it("blocks an off-scope window.open (returns null, no navigation)", () => {
    installNetworkCounter({ allowedDomains: ["myapp.test"] });
    const before = window.location.href;
    expect(window.open("https://evil.example/x", "_blank")).toBeNull();
    expect(window.location.href).toBe(before);
  });

  it("returns null even for an in-scope window.open (never a real new tab/window)", () => {
    installNetworkCounter({ allowedDomains: ["myapp.test"] });
    expect(window.open("https://app.myapp.test/x")).toBeNull();
  });
});
