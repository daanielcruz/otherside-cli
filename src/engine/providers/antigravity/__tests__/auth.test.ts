import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentTokens } from "@/engine/providers/antigravity/auth.ts";
import { saveFor } from "@/kernel/storage/credentials.ts";

const originalFetch = globalThis.fetch;
let configDir: string;

describe("antigravity OAuth refresh", () => {
  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "antigravity-auth-test-"));
    process.env.OTHERSIDE_CONFIG_DIR = configDir;
    await saveFor("antigravity", {
      accessToken: "expired_access",
      refreshToken: "google_refresh",
      expiresAt: Date.now() - 1,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OTHERSIDE_CONFIG_DIR;
    rmSync(configDir, { recursive: true, force: true });
  });

  test("single-flights concurrent refreshes", async () => {
    let refreshCalls = 0;
    globalThis.fetch = mock(async () => {
      refreshCalls++;
      return new Response(
        JSON.stringify({
          access_token: "fresh_access",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const [first, second] = await Promise.all([currentTokens(), currentTokens()]);

    expect(refreshCalls).toBe(1);
    expect(first.accessToken).toBe("fresh_access");
    expect(second.accessToken).toBe("fresh_access");
  });
});
