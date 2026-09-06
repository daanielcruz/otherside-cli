import { beforeEach, describe, expect, test } from "bun:test";
import { overlayStore } from "@/store/overlay-stack/index.ts";
import type { StringViewDispatch } from "@/ui/app/dispatch/string-view-dispatch.ts";
import { openPortedOverlayFromInput } from "@/ui/app/string-view-root.ts";

const broker = {} as StringViewDispatch["broker"];
const dispatch = {
  broker,
  config: {},
  onConfigChange: () => {},
} as unknown as StringViewDispatch;

beforeEach(() => {
  overlayStore.setState(() => ({ openStack: [], pendingChain: [], slices: {} }));
});

describe("string-view overlay routing", () => {
  test("defers commands with behavioral arguments to slash dispatch", () => {
    expect(openPortedOverlayFromInput("/model gpt-5", dispatch)).toBe(false);
    expect(openPortedOverlayFromInput("/effort high", dispatch)).toBe(false);
    expect(openPortedOverlayFromInput("/plugins install example", dispatch)).toBe(false);
    expect(openPortedOverlayFromInput("/design build a dashboard", dispatch)).toBe(false);
    expect(overlayStore.getState().openStack).toEqual([]);
  });

  test("hands the design overlay a controller so start is reachable", () => {
    let built = 0;
    const withDesign = {
      ...dispatch,
      session: { id: "s1" },
      designController: () => {
        built += 1;
        return { start: async () => {}, stop: async () => {} };
      },
    } as unknown as StringViewDispatch;

    expect(openPortedOverlayFromInput("/design", withDesign)).toBe(true);
    expect(built).toBe(1);
    const opened = overlayStore.getState().openStack.at(-1);
    expect(opened?.name).toBe("design");
    expect((opened?.props as { controller?: unknown }).controller).toBeDefined();
  });

  test("opens plain panels directly", () => {
    expect(openPortedOverlayFromInput("/help", dispatch)).toBe(true);
    expect(overlayStore.getState().openStack.at(-1)).toEqual({ name: "help", props: undefined });
  });

  test("preserves config tab and login provider arguments", () => {
    expect(openPortedOverlayFromInput("/config details", dispatch)).toBe(true);
    expect(overlayStore.getState().openStack.at(-1)).toEqual({
      name: "config",
      props: { initialTab: "details" },
    });

    expect(openPortedOverlayFromInput("/login codex", dispatch)).toBe(true);
    const login = overlayStore.getState().openStack.at(-1);
    expect(login?.name).toBe("login");
    expect(login?.props).toMatchObject({ broker, initialProvider: "codex" });
  });
});
