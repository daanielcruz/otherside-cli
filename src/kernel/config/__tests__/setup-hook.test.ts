import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimInitialSetupHook,
  configPath,
  loadConfig,
  saveConfig,
  type UserConfig,
} from "../config.ts";

let oldConfigDir: string | undefined;
let testConfigDir: string;

beforeEach(() => {
  oldConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  testConfigDir = mkdtempSync(join(tmpdir(), "otherside-setup-hook-"));
  process.env.OTHERSIDE_CONFIG_DIR = testConfigDir;
});

afterEach(() => {
  if (oldConfigDir === undefined) {
    delete process.env.OTHERSIDE_CONFIG_DIR;
  } else {
    process.env.OTHERSIDE_CONFIG_DIR = oldConfigDir;
  }
  rmSync(testConfigDir, { recursive: true, force: true });
});

function writeSettings(raw: unknown): void {
  const path = configPath();
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
}

describe("removed settings", () => {
  it("ignores and drops the legacy dictation language on persistence", async () => {
    writeSettings({ dictationLanguage: "pt", language: "Japanese" });

    const cfg = await loadConfig();
    expect((cfg as unknown as Record<string, unknown>).dictationLanguage).toBeUndefined();
    expect(cfg.language).toBe("Japanese");

    await saveConfig(cfg);
    const persisted = JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
    expect(persisted.dictationLanguage).toBeUndefined();
  });
});

describe("claimInitialSetupHook", () => {
  it("claims and marks only the first config creation", () => {
    expect(existsSync(configPath())).toBe(false);

    expect(claimInitialSetupHook()).toBe(true);
    expect(claimInitialSetupHook()).toBe(false);

    const cfg = JSON.parse(readFileSync(configPath(), "utf8")) as UserConfig;
    expect(cfg.global?.setupHookFired).toBe(true);
  });

  it("does not claim when the marker is already present", () => {
    writeSettings({ global: { setupHookFired: true } });

    expect(claimInitialSetupHook()).toBe(false);
  });

  it("does not claim a preexisting config without the marker", () => {
    writeSettings({});

    expect(claimInitialSetupHook()).toBe(false);
  });
});
