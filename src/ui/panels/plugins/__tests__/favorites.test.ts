import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigSync, updateConfig } from "@/kernel/config/config.ts";

describe("pluginFavorites config key", () => {
  let previousConfigDir: string | undefined;
  let configDir: string;

  beforeEach(() => {
    previousConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), "otherside-plugin-favorites-"));
    process.env.OTHERSIDE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = previousConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("persists canonical plugin identities across a config reload", async () => {
    await updateConfig((cfg) => {
      cfg.pluginFavorites = ["zeta@claude-plugins-official", "alpha@claude-plugins-official"];
    });

    const reloaded = loadConfigSync();
    expect(reloaded.pluginFavorites).toEqual([
      "zeta@claude-plugins-official",
      "alpha@claude-plugins-official",
    ]);
  });
});
