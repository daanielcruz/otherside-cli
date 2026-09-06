import { describe, expect, test } from "bun:test";
import type { ErrorActionId } from "@/engine/transport/error-meta.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.ts";
import { createStringViewPanel, isPortedOverlay } from "@/ui/panels/string-view-registry.ts";

const key = (name: string | undefined, sequence?: string): KeyEventData => ({
  kind: "key",
  fn: false,
  name,
  ctrl: false,
  meta: false,
  shift: false,
  option: false,
  super: false,
  sequence,
  raw: sequence,
  isPasted: false,
});

describe("blocking string-view panels", () => {
  test("renders error actions and delegates the selected recovery", () => {
    const actions: ErrorActionId[] = [];
    let closes = 0;
    const panel = createStringViewPanel("error", () => closes++, {
      meta: {
        source: "transport",
        errorClass: "other",
        modal: true,
        retryable: true,
        title: "Request failed",
        summary: "Could not complete the request.",
        rawDetail: "raw failure",
        actions: [
          { id: "retry", label: "Retry" },
          { id: "switch-model", label: "Switch model" },
        ],
      },
      onAction: (id: ErrorActionId) => actions.push(id),
    });

    expect(stripAnsi(panel.render(80).join("\n"))).toContain("Request failed");
    panel.handleKey(key("down"));
    panel.handleKey(key("return"));
    expect(actions).toEqual(["switch-model"]);
    expect(closes).toBe(1);
  });

  test("renders quota choices and invokes both outcomes", () => {
    let switches = 0;
    let dismisses = 0;
    const first = createStringViewPanel("quota", () => {}, {
      onSwitchModel: () => switches++,
      onDismiss: () => dismisses++,
    });
    expect(stripAnsi(first.render(80).join("\n"))).toContain("Switch model");
    first.handleKey(key(undefined, "1"));
    expect(switches).toBe(1);

    const second = createStringViewPanel("quota", () => {}, {
      onSwitchModel: () => switches++,
      onDismiss: () => dismisses++,
    });
    second.handleKey(key("down"));
    second.handleKey(key("return"));
    expect(dismisses).toBe(1);
    expect(isPortedOverlay("error")).toBe(true);
    expect(isPortedOverlay("quota")).toBe(true);
  });
});
