import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialsPath, loadAll, saveFor, type XaiTokens } from "../credentials.ts";

describe("credentials storage", () => {
  const testConfigDir = join(
    tmpdir(),
    `otherside-test-config-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    originalConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = testConfigDir;
  });

  afterEach(() => {
    if (originalConfigDir !== undefined) {
      process.env.OTHERSIDE_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.OTHERSIDE_CONFIG_DIR;
    }
    try {
      rmSync(testConfigDir, { recursive: true, force: true });
    } catch {}
  });

  it("does not migrate legacy provider keys on load", async () => {
    const path = credentialsPath();
    const mockGrokTokens = {
      accessToken: "mock-access-token",
      refreshToken: "mock-refresh-token",
      expiresAt: Date.now() + 100000,
    };
    const fs = require("node:fs");
    fs.mkdirSync(testConfigDir, { recursive: true });
    fs.writeFileSync(path, JSON.stringify({ grok: mockGrokTokens }, null, 2), "utf8");

    const loaded = await loadAll();
    expect(loaded.xai).toBeUndefined();
    expect((loaded as Record<string, unknown>).grok).toEqual(mockGrokTokens);

    const diskContent = JSON.parse(fs.readFileSync(path, "utf8"));
    expect(diskContent.xai).toBeUndefined();
    expect(diskContent.grok).toEqual(mockGrokTokens);

    const updatedXaiTokens: XaiTokens = {
      ...mockGrokTokens,
      accessToken: "updated-access-token",
    };
    await saveFor("xai", updatedXaiTokens);

    const savedContent = JSON.parse(fs.readFileSync(path, "utf8"));
    expect(savedContent.xai).toEqual(updatedXaiTokens);
    expect(savedContent.grok).toEqual(mockGrokTokens);
  });
});
