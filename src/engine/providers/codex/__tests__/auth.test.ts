import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CodexTokens, loadFor, saveFor } from "@/kernel/storage/credentials.ts";
import { Auth, currentTokens } from "../auth.ts";

let configDir: string;
const originalFetch = global.fetch;

function mockJwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds }))
    .toString("base64")
    .replace(/=/g, "");
  return `header.${payload}.signature`;
}

describe("codex oauth refresh", () => {
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "codex-oauth-test-"));
    process.env.OTHERSIDE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.OTHERSIDE_CONFIG_DIR;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("performs exactly one network refresh for concurrent calls inside margin", async () => {
    await saveFor("codex", {
      accessToken: "old_access",
      refreshToken: "old_refresh",
      expiresAt: Date.now() + 2 * 60_000,
    });

    const newExp = Math.floor((Date.now() + 10 * 60_000) / 1000);
    const newAccess = mockJwt(newExp);

    let fetchCount = 0;
    global.fetch = mock((_url: string | URL | Request, _init?: RequestInit) => {
      fetchCount++;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: newAccess,
            refresh_token: "new_refresh",
          }),
          { status: 200 },
        ),
      );
    }) as unknown as typeof fetch;

    const [t1, t2] = await Promise.all([currentTokens(), currentTokens()]);

    expect(fetchCount).toBe(1);
    expect(t1.accessToken).toBe(newAccess);
    expect(t1.refreshToken).toBe("new_refresh");
    expect(t2.accessToken).toBe(newAccess);
    expect(t2.refreshToken).toBe("new_refresh");

    const saved = await loadFor("codex");
    expect(saved?.accessToken).toBe(newAccess);
    expect(saved?.refreshToken).toBe("new_refresh");
  });

  it("returns cached tokens on transient failure if still valid", async () => {
    const expiresAt = Date.now() + 2 * 60_000;
    await saveFor("codex", {
      accessToken: "valid_access",
      refreshToken: "old_refresh",
      expiresAt,
    });

    global.fetch = mock((_url: string | URL | Request, _init?: RequestInit) => {
      return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
    }) as unknown as typeof fetch;

    const t = await currentTokens();
    expect(t.accessToken).toBe("valid_access");
    expect(t.expiresAt).toBe(expiresAt);
  });

  it("rethrows error on refresh failure if token has expired", async () => {
    const expiresAt = Date.now() - 2 * 60_000;
    await saveFor("codex", {
      accessToken: "expired_access",
      refreshToken: "old_refresh",
      expiresAt,
    });

    global.fetch = mock((_url: string | URL | Request, _init?: RequestInit) => {
      return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
    }) as unknown as typeof fetch;

    await expect(currentTokens()).rejects.toThrow("codex refresh 500");
  });

  it("applies the single-flight to the Auth strategy refresh path", async () => {
    const initialTokens = {
      accessToken: "old_access",
      refreshToken: "old_refresh",
      expiresAt: Date.now() + 2 * 60_000,
    };
    await saveFor("codex", initialTokens);

    const newExp = Math.floor((Date.now() + 10 * 60_000) / 1000);
    const newAccess = mockJwt(newExp);

    let fetchCount = 0;
    global.fetch = mock((_url: string | URL | Request, _init?: RequestInit) => {
      fetchCount++;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: newAccess,
            refresh_token: "new_refresh",
          }),
          { status: 200 },
        ),
      );
    }) as unknown as typeof fetch;

    const creds = {
      kind: "oauth" as const,
      expiresAt: initialTokens.expiresAt,
      raw: initialTokens,
    };
    const [c1, c2] = await Promise.all([Auth.refresh(creds), Auth.refresh(creds)]);

    expect(fetchCount).toBe(1);
    expect((c1.raw as CodexTokens).accessToken).toBe(newAccess);
    expect((c1.raw as CodexTokens).refreshToken).toBe("new_refresh");
    expect((c2.raw as CodexTokens).accessToken).toBe(newAccess);
    expect((c2.raw as CodexTokens).refreshToken).toBe("new_refresh");
  });
});
