import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";

// Tasks persist under the config root, so this suite runs against a disposable one.
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "otherside-mode-hint-"));
const PREVIOUS_CONFIG_DIR = process.env.OTHERSIDE_CONFIG_DIR;
process.env.OTHERSIDE_CONFIG_DIR = CONFIG_DIR;

const { clear: clearTasks, create: createTask } = await import(
  "@/engine/background/tasks/index.ts"
);
const { registerAllProviders } = await import("@/engine/providers/bootstrap.ts");
const { appStore, dispatch } = await import("@/store/app-store/index.ts");
const { stripAnsi } = await import("@/terminal-runtime/text/presentation-sequences.js");
const { StringViewStatusBar } = await import("@/ui/chrome/status/string-view-status-bar.ts");

const originalColorLevel = chalk.level;
const initialAppState = appStore.getState();

beforeEach(() => {
  chalk.level = 3;
  registerAllProviders();
  appStore.setState(() => initialAppState);
  dispatch({
    type: "engine/setSlice",
    key: "broker",
    value: {
      provider: "anthropic",
      model: "claude-opus-5",
      effort: "high",
      fastMode: false,
      permissionMode: "yolo",
      orchestrationMode: "disabled",
    },
  });
  clearTasks();
});

afterEach(() => {
  clearTasks();
  appStore.setState(() => initialAppState);
  chalk.level = originalColorLevel;
});

afterAll(() => {
  if (PREVIOUS_CONFIG_DIR === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = PREVIOUS_CONFIG_DIR;
  rmSync(CONFIG_DIR, { recursive: true, force: true });
});

function modeRow(): string {
  return stripAnsi(new StringViewStatusBar().render(100)[0] ?? "");
}

describe("the mode row's trailing hint", () => {
  it("reminds about mode cycling while there are no tasks", () => {
    expect(modeRow()).toContain("shift+tab to cycle");
    expect(modeRow()).not.toContain("ctrl+t");
  });

  // The mode row's tail belongs to the mode cycle: tasks never displace it, because
  // the shortcut that opens them announces itself beside the next task instead.
  it("keeps the mode cycle even once tasks exist", () => {
    createTask({ subject: "audit the emitter", description: "" });
    expect(modeRow()).toContain("shift+tab to cycle");
    expect(modeRow()).not.toContain("ctrl+t");
  });

  it("keeps the mode cycle while the list is open", () => {
    createTask({ subject: "audit the emitter", description: "" });
    dispatch({ type: "view/setTasksExpanded", value: true });
    expect(modeRow()).toContain("shift+tab to cycle");
    expect(modeRow()).not.toContain("ctrl+t");
  });

  // With the cursor on the agent rows the left side names what the keys do
  // there, replacing the permission chip until focus returns to the prompt.
  it("names the row keys while the agents panel holds the cursor", () => {
    dispatch({ type: "view/setPanelFocused", focused: true });
    expect(modeRow()).toContain("Enter to view · x to stop");
    expect(modeRow()).not.toContain("shift+tab to cycle");

    dispatch({ type: "view/setPanelFocused", focused: false });
    expect(modeRow()).toContain("shift+tab to cycle");
  });
});
