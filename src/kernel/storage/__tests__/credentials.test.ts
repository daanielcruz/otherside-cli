import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialsPath, loadAll, saveFor, type XaiTokens } from "../credentials.ts";

describe("credentials storage migration", () => {
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

  it("migrates grok credentials to xai on load and drops grok on save", async () => {
    const path = credentialsPath();
    const mockGrokTokens = {
      accessToken: "mock-access-token",
      refreshToken: "mock-refresh-token",
      expiresAt: Date.now() + 100000,
    };
    const mockBundle = {
      grok: mockGrokTokens,
      anthropic: {
        accessToken: "anthropic-token",
        refreshToken: "anthropic-refresh",
        expiresAt: Date.now() + 100000,
      },
    };

    // Prepare credentials file directly on disk with grok key
    const fs = require("node:fs");
    fs.mkdirSync(testConfigDir, { recursive: true });
    fs.writeFileSync(path, JSON.stringify(mockBundle, null, 2), "utf8");

    // Load credentials - this should trigger the migration and write to disk
    const loaded = await loadAll();
    expect(loaded.xai).toEqual(mockGrokTokens);
    expect((loaded as Record<string, unknown>).grok).toBeUndefined();

    // Verify it updated the file on disk
    const diskContent = JSON.parse(fs.readFileSync(path, "utf8"));
    expect(diskContent.xai).toEqual(mockGrokTokens);
    expect(diskContent.grok).toBeUndefined();

    // Now save a modification and verify grok is still gone
    const updatedXaiTokens: XaiTokens = {
      ...mockGrokTokens,
      accessToken: "updated-access-token",
    };
    await saveFor("xai", updatedXaiTokens);

    const savedContent = JSON.parse(fs.readFileSync(path, "utf8"));
    expect(savedContent.xai).toEqual(updatedXaiTokens);
    expect(savedContent.grok).toBeUndefined();
  });
});
