import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userSettingsPath } from "@/kernel/config/scope.ts";
import { stopWatchingSettings, watchSettingsFiles } from "@/kernel/config/settings-watch.ts";
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

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("the status row and a settings file that changed under it", () => {
  test("repaints when one settles, so a style change does not wait for the next session", async () => {
    const line = new StringViewStatusLine();
    let renders = 0;
    line.mount({ requestRender: () => renders++, pushFocus: () => {}, popFocus: () => {} });
    watchSettingsFiles(process.cwd());
    const atMount = renders;

    writeFileSync(userSettingsPath(), JSON.stringify({ outputStyle: "Explanatory" }));
    await until(() => renders > atMount);
    expect(renders).toBeGreaterThan(atMount);
    line.unmount();
  });

  test("a torn-down row hears nothing more", async () => {
    const line = new StringViewStatusLine();
    let renders = 0;
    line.mount({ requestRender: () => renders++, pushFocus: () => {}, popFocus: () => {} });
    watchSettingsFiles(process.cwd());
    line.unmount();
    const atUnmount = renders;

    writeFileSync(userSettingsPath(), JSON.stringify({ outputStyle: "Explanatory" }));
    await until(() => renders > atUnmount, 500);
    expect(renders).toBe(atUnmount);
  });
});
