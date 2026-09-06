import { afterEach, describe, expect, test } from "bun:test";
import { redrawSurface, setSurfaceRedraw } from "@/ui/app/redraw.ts";

afterEach(() => {
  setSurfaceRedraw(null);
});

describe("the way back after an outside clear", () => {
  test("reaches the surface holding the frame", () => {
    let called = 0;
    setSurfaceRedraw(() => called++);
    expect(redrawSurface()).toBe(true);
    expect(called).toBe(1);
  });

  test("says so when nothing holds the frame, so the key can fall through", () => {
    // Print mode and the boot window have no surface; the press must not be
    // swallowed by a handler that did nothing.
    expect(redrawSurface()).toBe(false);
  });

  test("a surface torn down stops answering", () => {
    setSurfaceRedraw(() => {});
    setSurfaceRedraw(null);
    expect(redrawSurface()).toBe(false);
  });
});
