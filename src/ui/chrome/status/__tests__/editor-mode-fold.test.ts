import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";

// Background tasks persist under the config root, so this suite runs against a
// disposable one rather than the reader's.
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "otherside-editor-mode-"));
const PREVIOUS_CONFIG_DIR = process.env.OTHERSIDE_CONFIG_DIR;
process.env.OTHERSIDE_CONFIG_DIR = CONFIG_DIR;

const { clear: clearTasks } = await import("@/engine/background/tasks/index.ts");
const { registerAllProviders } = await import("@/engine/providers/bootstrap.ts");
const { appStore, dispatch } = await import("@/store/app-store/index.ts");
const { setPromptEditorMode, setPromptSearch } = await import("@/store/prompt/index.ts");
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
  setPromptEditorMode(null);
  setPromptSearch(null);
  appStore.setState(() => initialAppState);
  chalk.level = originalColorLevel;
});

afterAll(() => {
  if (PREVIOUS_CONFIG_DIR === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = PREVIOUS_CONFIG_DIR;
  rmSync(CONFIG_DIR, { recursive: true, force: true });
});

function statusRow(width = 100): string[] {
  return new StringViewStatusBar().render(width).map((row) => stripAnsi(row));
}

describe("the editor mode on the status row", () => {
  it("announces itself ahead of the permission chip on one row", () => {
    setPromptEditorMode("-- INSERT --");
    const rows = statusRow();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("-- INSERT -- ");
    expect(rows[0]?.indexOf("-- INSERT --")).toBeLessThan(rows[0]?.indexOf("yolo mode on") ?? 0);
  });

  it("spends no row of its own", () => {
    expect(statusRow()).toHaveLength(1);

    setPromptEditorMode("-- VISUAL LINE --");

    expect(statusRow()).toHaveLength(1);
  });

  it("leaves the row to the chip alone when no mode is announced", () => {
    const row = statusRow()[0] ?? "";

    expect(row).not.toContain("--");
    expect(row).toContain("shift+tab to cycle");
  });

  // The row would otherwise carry two pieces of live state plus a chord to learn,
  // and the clipping would pick which one is lost.
  it("gives up the cycle hint rather than letting the row clip", () => {
    setPromptEditorMode("-- INSERT --");

    expect(statusRow()[0]).not.toContain("shift+tab to cycle");
  });

  it("stands aside while a search owns the row", () => {
    setPromptEditorMode("-- INSERT --");
    setPromptSearch({ query: "deploy", failed: false, scope: "session" });

    const row = statusRow()[0] ?? "";

    expect(row).toContain("search prompts");
    expect(row).not.toContain("-- INSERT --");
  });
});
