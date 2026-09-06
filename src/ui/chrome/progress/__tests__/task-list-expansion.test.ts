import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appStore } from "@/store/app-store/index.ts";
import {
  readTaskListExpanded,
  restoreTaskListExpansion,
  setTaskListExpanded,
} from "@/ui/chrome/progress/task-list-expansion.ts";

const initialAppState = appStore.getState();
let configDir: string | undefined;
let savedConfigDir: string | undefined;

beforeEach(() => {
  savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  configDir = mkdtempSync(join(tmpdir(), "otherside-task-list-"));
  process.env.OTHERSIDE_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
  if (configDir !== undefined) rmSync(configDir, { recursive: true, force: true });
  appStore.setState(() => initialAppState);
});

describe("task list expansion", () => {
  it("starts closed and reopens where the last session left it", async () => {
    expect(readTaskListExpanded()).toBe(false);

    setTaskListExpanded(true);
    expect(appStore.getState().view.tasksExpanded).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(readTaskListExpanded()).toBe(true);

    appStore.setState(() => initialAppState);
    expect(appStore.getState().view.tasksExpanded).toBe(false);
    restoreTaskListExpansion();
    expect(appStore.getState().view.tasksExpanded).toBe(true);
  });
});
