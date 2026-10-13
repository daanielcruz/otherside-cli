import { afterEach, describe, expect, it } from "bun:test";
import { askGroup, clear as clearQuestions } from "@/kernel/channels/ask.ts";
import { ask, clear as clearPermissions } from "@/kernel/channels/permission.ts";
import type { StringComponent } from "@/terminal-runtime/string-view/component.js";
import { FRAME_BOTTOM_MARGIN } from "@/ui/chrome/string-view-chrome-region.ts";
import { StringViewPromptDock } from "@/ui/chrome/string-view-prompt-dock.ts";

const WIDTH = 40;

const promptBar: StringComponent = {
  render: () => ["prompt row", "status row"],
  caret: () => ({ row: 0, column: 2 }),
};

function dock(): StringViewPromptDock {
  const dock = new StringViewPromptDock();
  dock.addChild(promptBar);
  return dock;
}

function permissionRequest(): void {
  void ask({ toolName: "Bash", argsPreview: "ls", rule: null, input: { command: "ls" } });
}

function questionRequest(): void {
  void askGroup([
    {
      question: "Pick one?",
      header: "Pick",
      options: [{ label: "Alpha", description: "" }],
      multiSelect: false,
    },
  ]);
}

afterEach(() => {
  clearPermissions();
  clearQuestions();
});

describe("StringViewPromptDock", () => {
  it("shows the prompt bar and status rows when nothing awaits a decision", () => {
    const view = dock();

    expect(view.render(WIDTH)).toEqual(["prompt row", "status row"]);
    expect(view.caret(WIDTH)).toEqual({ row: 0, column: 2 });
  });

  it("stows them behind the bottom margin while a permission request is open", () => {
    const view = dock();
    permissionRequest();

    expect(view.render(WIDTH)).toEqual([...FRAME_BOTTOM_MARGIN]);
    expect(view.caret(WIDTH)).toBeNull();
  });

  it("stows them while a question is open", () => {
    const view = dock();
    questionRequest();

    expect(view.render(WIDTH)).toEqual([...FRAME_BOTTOM_MARGIN]);
  });

  it("brings them back once the decision closes", () => {
    const view = dock();
    permissionRequest();
    view.render(WIDTH);
    clearPermissions();

    expect(view.render(WIDTH)).toEqual(["prompt row", "status row"]);
  });
});
