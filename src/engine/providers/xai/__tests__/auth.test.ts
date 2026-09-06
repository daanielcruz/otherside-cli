import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expiresMsFor, forceRefreshTokens } from "@/engine/providers/xai/auth.ts";
import { saveFor } from "@/kernel/storage/credentials.ts";

const FIVE_MIN = 5 * 60 * 1000;

describe("expiresMsFor", () => {
  test("caps the device poll at 5 minutes even when the server allows longer", () => {
    // auth.x.ai returns expires_in=1800 (30 min); an abandoned poll must stop at 5.
    expect(expiresMsFor(1800)).toBe(FIVE_MIN);
    expect(expiresMsFor(600)).toBe(FIVE_MIN);
  });

  test("honors a shorter server window under the cap", () => {
    expect(expiresMsFor(120)).toBe(120_000);
  });

  test("falls back to the cap when expires_in is missing or invalid", () => {
    expect(expiresMsFor(undefined)).toBe(FIVE_MIN);
    expect(expiresMsFor(0)).toBe(FIVE_MIN);
    expect(expiresMsFor(-5)).toBe(FIVE_MIN);
  });
});

describe("xai OAuth refresh", () => {
  const originalFetch = globalThis.fetch;
  let configDir: string;

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "xai-oauth-test-"));
    process.env.OTHERSIDE_CONFIG_DIR = configDir;
    await saveFor("xai", {
      accessToken: "stale_access",
      refreshToken: "stale_refresh",
      expiresAt: Date.now() + 10 * 60_000,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OTHERSIDE_CONFIG_DIR;
    rmSync(configDir, { recursive: true, force: true });
  });

  test("adopts the persisted winner after invalid_grant", async () => {
    let refreshCalls = 0;
    globalThis.fetch = mock(async () => {
      refreshCalls++;
      await saveFor("xai", {
        accessToken: "winner_access",
        refreshToken: "winner_refresh",
        expiresAt: Date.now() + 60 * 60_000,
      });
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }) as unknown as typeof fetch;

    const tokens = await forceRefreshTokens({
      accessToken: "stale_access",
      refreshToken: "stale_refresh",
      expiresAt: Date.now() + 10 * 60_000,
    });

    expect(refreshCalls).toBe(1);
    expect(tokens.accessToken).toBe("winner_access");
    expect(tokens.refreshToken).toBe("winner_refresh");
  });
});
