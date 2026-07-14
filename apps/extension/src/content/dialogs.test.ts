import { afterEach, describe, expect, it, vi } from "vitest";
import { neutralizeDialogs, neutralizeDialogsInPage } from "./crawl-inject";

describe("neutralizeDialogs (FR-EX-073)", () => {
  it("makes confirm() return false so it can't stall the crawl", () => {
    const w: Record<string, unknown> = { confirm: () => true };
    neutralizeDialogs(w);
    expect((w.confirm as () => boolean)()).toBe(false);
  });

  it("makes alert() a no-op and prompt() return null", () => {
    const w: Record<string, unknown> = {};
    neutralizeDialogs(w);
    expect((w.alert as () => unknown)()).toBeUndefined();
    expect((w.prompt as () => unknown)()).toBeNull();
  });

  it("clears onbeforeunload and locks it so the page can't re-arm the prompt", () => {
    const addEventListener = vi.fn();
    const w: Record<string, unknown> = { onbeforeunload: () => "stay?", addEventListener };
    neutralizeDialogs(w as never);

    // Cleared, and a later assignment is ignored (no-op setter).
    expect(w.onbeforeunload).toBeNull();
    (w as { onbeforeunload: unknown }).onbeforeunload = () => "again";
    expect(w.onbeforeunload).toBeNull();
  });

  it("registers a capture-phase beforeunload swallow that CLEARS (never arms) returnValue", () => {
    const addEventListener = vi.fn();
    const w: Record<string, unknown> = { addEventListener };
    neutralizeDialogs(w as never);

    expect(addEventListener).toHaveBeenCalledWith("beforeunload", expect.any(Function), true);
    const handler = addEventListener.mock.calls.find((c) => c[0] === "beforeunload")![1] as (
      e: unknown,
    ) => void;
    const stop = vi.fn();
    const ev: { stopImmediatePropagation: () => void; returnValue?: unknown } = {
      stopImmediatePropagation: stop,
      returnValue: "x",
    };
    handler(ev);
    expect(stop).toHaveBeenCalled();
    // "" (empty), NOT undefined — undefined coerces to the string "undefined",
    // which is non-empty and would itself arm the "Leave site?" prompt.
    expect(ev.returnValue).toBe("");
  });

  it("swallows further beforeunload registrations but lets other events through", () => {
    const addEventListener = vi.fn();
    const w: Record<string, unknown> = { addEventListener };
    neutralizeDialogs(w as never);
    addEventListener.mockClear();

    (w.addEventListener as (t: string, h: () => void) => void)("beforeunload", () => {});
    expect(addEventListener).not.toHaveBeenCalled(); // dropped at the source

    const onClick = (): void => {};
    (w.addEventListener as (t: string, h: () => void) => void)("click", onClick);
    expect(addEventListener).toHaveBeenCalledWith("click", onClick);
  });

  it("tolerates a window without addEventListener", () => {
    const w: Record<string, unknown> = {};
    expect(() => neutralizeDialogs(w)).not.toThrow();
  });
});

describe("neutralizeDialogsInPage (FR-EX-073, injected)", () => {
  const realAddEventListener = window.addEventListener;
  afterEach(() => {
    (window as unknown as { __scDialogsPatched?: boolean }).__scDialogsPatched = undefined;
    // Undo the patches so the shared happy-dom window stays clean between tests.
    window.addEventListener = realAddEventListener;
    try {
      delete (window as unknown as { onbeforeunload?: unknown }).onbeforeunload;
    } catch {
      /* ignore */
    }
  });

  it("overrides the real window's dialogs so confirm() can't stall the crawl", () => {
    neutralizeDialogsInPage();
    expect(window.confirm()).toBe(false);
    expect(window.alert()).toBeUndefined();
    expect(window.prompt()).toBeNull();
  });

  it("locks onbeforeunload to null so the page can't re-arm the prompt", () => {
    neutralizeDialogsInPage();
    (window as unknown as { onbeforeunload: unknown }).onbeforeunload = () => "stay?";
    expect(window.onbeforeunload).toBeNull();
  });

  it("drops a beforeunload listener added after neutralization (EC-022)", () => {
    neutralizeDialogsInPage();
    const fn = vi.fn();
    window.addEventListener("beforeunload", fn);
    window.dispatchEvent(new Event("beforeunload"));
    expect(fn).not.toHaveBeenCalled();
  });

  it("is idempotent (guarded by __scDialogsPatched)", () => {
    const spy = vi.spyOn(window, "addEventListener");
    neutralizeDialogsInPage();
    neutralizeDialogsInPage();
    const beforeunloadRegs = spy.mock.calls.filter((c) => c[0] === "beforeunload");
    expect(beforeunloadRegs.length).toBe(1);
  });
});
