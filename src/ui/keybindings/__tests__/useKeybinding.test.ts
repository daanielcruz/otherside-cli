import { describe, expect, test } from "bun:test";
import { keybindingResolveContextsForHandler } from "../useKeybinding.ts";

describe("keybinding modal focus", () => {
  test("suppresses overlay-context handlers while a higher modal layer is active", () => {
    const activeContexts = new Set(["Overlay:help", "PanelDefaults"]);

    expect(
      keybindingResolveContextsForHandler({
        context: "Overlay:help",
        activeContexts,
        topLayer: "permission",
      }),
    ).toBeNull();
    expect(
      keybindingResolveContextsForHandler({
        context: "Overlay:help",
        activeContexts,
        topLayer: "ask",
      }),
    ).toBeNull();
  });

  test("keeps Global handlers active without lower contexts", () => {
    expect(
      keybindingResolveContextsForHandler({
        context: "Global",
        activeContexts: new Set(["Overlay:help", "PanelDefaults"]),
        topLayer: "permission",
      }),
    ).toEqual(["Global"]);
  });

  test("keeps the modal's own overlay context active", () => {
    expect(
      keybindingResolveContextsForHandler({
        context: "Overlay:help",
        activeContexts: new Set(["Overlay:help", "PanelDefaults"]),
        topLayer: "overlay",
      }),
    ).toEqual(["Overlay:help", "PanelDefaults", "Global"]);
  });

  test("restores non-global contexts when the layer clears", () => {
    expect(
      keybindingResolveContextsForHandler({
        context: "Overlay:help",
        activeContexts: new Set(["PanelDefaults"]),
        topLayer: "none",
      }),
    ).toEqual(["PanelDefaults", "Overlay:help", "Global"]);
  });

  test("suppresses unmarked non-global contexts while a modal layer is active", () => {
    expect(
      keybindingResolveContextsForHandler({
        context: "PanelDefaults",
        activeContexts: new Set(["PanelDefaults"]),
        topLayer: "overlay",
      }),
    ).toBeNull();
  });
});
