import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "@/kernel/config/config.ts";
import { appStore, dispatch } from "@/store/app-store/index.ts";
import {
  readTaskListExpanded,
  restoreTaskListExpansion,
  setTaskListExpanded,
} from "@/ui/chrome/progress/task-list-expansion.ts";

let initialAppState = appStore.getState();
let configDir: string | undefined;
let savedConfigDir: string | undefined;

function closeTaskList(): void {
  dispatch({ type: "view/setTasksExpanded", value: false });
}

beforeEach(() => {
  initialAppState = appStore.getState();
  closeTaskList();
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

    const configWrite = spyOn(config, "updateConfig");
    try {
      setTaskListExpanded(true);
      expect(appStore.getState().view.tasksExpanded).toBe(true);
      expect(configWrite).toHaveBeenCalledTimes(1);
    } finally {
      const pendingWrite = configWrite.mock.results[0]?.value;
      configWrite.mockRestore();
      await pendingWrite;
    }
    expect(readTaskListExpanded()).toBe(true);

    closeTaskList();
    expect(appStore.getState().view.tasksExpanded).toBe(false);
    restoreTaskListExpansion();
    expect(appStore.getState().view.tasksExpanded).toBe(true);
  });
});
