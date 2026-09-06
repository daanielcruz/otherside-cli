import { afterEach, describe, expect, it } from "bun:test";
import { ask, clear as clearPermissions } from "@/kernel/channels/permission.ts";
import { appStore, dispatch } from "@/store/app-store/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.ts";
import { readStringViewBrokerState } from "@/ui/chrome/status/string-view-state.ts";
import { StringViewPermissionPrompt } from "@/ui/panels/permission/string-view.ts";

const WIDTH = 90;

const ctx: StringViewContext = {
  requestRender: () => {},
  pushFocus: () => {},
  popFocus: () => {},
};

const key = (name: string | undefined, overrides: Partial<KeyEventData> = {}): KeyEventData => ({
  kind: "key",
  fn: false,
  name,
  ctrl: false,
  meta: false,
  shift: false,
  option: false,
  super: false,
  sequence: undefined,
  raw: undefined,
  isPasted: false,
  ...overrides,
});

const initialEngine = appStore.getState().engine;

function mountedPrompt(): StringViewPermissionPrompt {
  const prompt = new StringViewPermissionPrompt();
  prompt.mount(ctx);
  return prompt;
}

function bashRequest(): void {
  void ask({
    toolName: "Bash",
    argsPreview: "ls -la",
    rule: "Bash(ls:*)",
    input: { command: "ls -la" },
  });
}

function planRequest(): void {
  void ask({
    toolName: "ExitPlanMode",
    argsPreview: "",
    rule: null,
    input: { plan: "Do the placeholder work" },
  });
}

function text(prompt: StringViewPermissionPrompt): string {
  return prompt.render(WIDTH).map(stripAnsi).join("\n");
}

afterEach(() => {
  clearPermissions();
  dispatch({ type: "engine/setSlice", key: "broker", value: initialEngine.broker });
});

describe("confirmation explanation section", () => {
  it("stays hidden until Ctrl+E asks for it and hides again on the second press", () => {
    bashRequest();
    const prompt = mountedPrompt();

    expect(text(prompt)).not.toContain("Call: Bash(ls -la)");
    expect(text(prompt)).toContain("Ctrl+E explain");

    prompt.handleKey(key("e", { ctrl: true }));
    const explained = text(prompt);
    expect(explained).toContain("Call: Bash(ls -la)");
    expect(explained).toContain("Rule: Bash(ls:*)");
    expect(explained).toContain("runs the call once; the next one asks again");
    expect(explained).toContain("refuses the call and tells the agent so");
    expect(explained).toContain("Ctrl+E hide explanation");

    prompt.handleKey(key("e", { ctrl: true }));
    expect(text(prompt)).not.toContain("Call: Bash(ls -la)");
    prompt.unmount();
  });

  it("explains the plan surface's answers too", () => {
    planRequest();
    const prompt = mountedPrompt();

    prompt.handleKey(key("e", { ctrl: true }));
    const explained = text(prompt);
    expect(explained).toContain("Ready to code?");
    expect(explained).toContain("keeps the plan open and sends your note back to the agent");
    prompt.unmount();
  });
});

describe("confirmation permission mode cycle", () => {
  it("cycles the session mode on shift+tab and names it in the footer", () => {
    dispatch({
      type: "engine/setSlice",
      key: "broker",
      value: { ...readStringViewBrokerState(), permissionMode: "plan" },
    });
    bashRequest();
    const prompt = mountedPrompt();
    expect(text(prompt)).toContain("Shift+Tab mode: plan");

    prompt.handleKey(key("tab", { shift: true }));

    expect(readStringViewBrokerState().permissionMode).toBe("yolo");
    expect(text(prompt)).toContain("Shift+Tab mode: yolo");
    prompt.unmount();
  });

  it("keeps shift+tab off the amend toggle that plain tab owns", () => {
    bashRequest();
    const prompt = mountedPrompt();

    prompt.handleKey(key("tab", { shift: true }));
    expect(text(prompt)).not.toContain("type feedback");

    prompt.handleKey(key("tab"));
    expect(text(prompt)).toContain("type feedback");
    prompt.unmount();
  });
});
