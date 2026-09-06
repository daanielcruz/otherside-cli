import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userSettingsPath } from "@/kernel/config/scope.ts";
import {
  SETTLE_MS,
  stopWatchingSettings,
  watchSettingsFiles,
} from "@/kernel/config/settings-watch.ts";
import { StringViewStatusLine } from "@/ui/chrome/status/string-view-status-line.ts";

// Owned by this file: the suite shares one process, so a config dir another file
// set is that file's to restore.
let configDir: string;
let priorConfigDir: string | undefined;

beforeEach(() => {
  priorConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  configDir = mkdtempSync(join(tmpdir(), "otherside-status-settings-"));
  process.env.OTHERSIDE_CONFIG_DIR = configDir;
  writeFileSync(userSettingsPath(), JSON.stringify({ outputStyle: "default" }));
});

afterEach(() => {
  stopWatchingSettings();
  if (priorConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = priorConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

async function startWatching(): Promise<void> {
  watchSettingsFiles(process.cwd());
  // Drain events from creating the settings file before observing the next write.
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS * 3));
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Status row did not repaint after the settings change settled within 3000ms");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("the status row and a settings file that changed under it", () => {
  test("repaints when one settles, so a style change does not wait for the next session", async () => {
    const line = new StringViewStatusLine();
    let renders = 0;
    try {
      line.mount({ requestRender: () => renders++, pushFocus: () => {}, popFocus: () => {} });
      await startWatching();
      const baseline = renders;

      writeFileSync(userSettingsPath(), JSON.stringify({ outputStyle: "Explanatory" }));
      await until(() => renders > baseline);
      expect(renders).toBeGreaterThan(baseline);
    } finally {
      line.unmount();
    }
  });

  test("a torn-down row hears nothing more", async () => {
    const line = new StringViewStatusLine();
    let renders = 0;
    try {
      line.mount({ requestRender: () => renders++, pushFocus: () => {}, popFocus: () => {} });
      await startWatching();
    } finally {
      line.unmount();
    }
    const atUnmount = renders;

    writeFileSync(userSettingsPath(), JSON.stringify({ outputStyle: "Explanatory" }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(renders).toBe(atUnmount);
  });
});
