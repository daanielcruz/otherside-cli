import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Auth,
  beginLogin,
  currentTokens,
  forceRefreshTokens,
} from "@/engine/providers/codex/auth.ts";
import { CLIENT_ID, ORIGINATOR_HTTP, SCOPE } from "@/engine/providers/codex/fingerprint.ts";
import { type CodexTokens, loadFor, saveFor } from "@/kernel/storage/credentials.ts";

let configDir: string;
const originalFetch = global.fetch;

function mockJwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds }))
    .toString("base64")
    .replace(/=/g, "");
  return `header.${payload}.signature`;
}

describe("codex oauth authorize", () => {
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "codex-oauth-test-"));
    process.env.OTHERSIDE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.OTHERSIDE_CONFIG_DIR;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("emits live Desktop authorize query params and reuses installation id", async () => {
    const installationId = "11111111-2222-3333-4444-555555555555";
    await saveFor("codex", {
      accessToken: "stale",
      refreshToken: "stale",
      expiresAt: Date.now() - 1,
      installationId,
      windowId: "window-1",
    });

    const flow = await beginLogin();
    const url = new URL(flow.url);
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    // Byte-identical key order to the live ChatGPT Desktop authorize wire.
    expect([...url.searchParams.keys()]).toEqual([
      "response_type",
      "client_id",
      "redirect_uri",
      "scope",
      "code_challenge",
      "code_challenge_method",
      "id_token_add_organizations",
      "codex_cli_simplified_flow",
      "state",
      "originator",
      "source_surface_stable_id",
      "codex_origin_stable_id",
      "codex_streamlined_login",
    ]);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("scope")).toBe(SCOPE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("id_token_add_organizations")).toBe("true");
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(url.searchParams.get("originator")).toBe(ORIGINATOR_HTTP);
    expect(url.searchParams.get("originator")).toBe("Codex Desktop");
    expect(url.searchParams.get("codex_streamlined_login")).toBe("true");
    expect(url.searchParams.get("source_surface_stable_id")).toBe(installationId);
    expect(url.searchParams.get("codex_origin_stable_id")).toBe(installationId);
    // redirect_uri MUST use an IdP-registered loopback port (1455 or 1457).
    expect(url.searchParams.get("redirect_uri")).toMatch(
      /^http:\/\/localhost:14(55|57)\/auth\/callback$/,
    );
    // SHA-256 challenge is always 43 base64url chars; 64-byte verifier -> 86 chars.
    expect(url.searchParams.get("code_challenge")?.length).toBe(43);
    expect(url.searchParams.get("state")?.length).toBe(43);

    // Reject without token exchange so the callback server stops cleanly.
    flow.submitCode("code#wrong-state");
    await expect(flow.result).rejects.toThrow(/state mismatch/);
  });
});

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

  it("adopts the persisted winner after a rotating refresh token is rejected", async () => {
    const initialTokens = {
      accessToken: "stale_access",
      refreshToken: "stale_refresh",
      expiresAt: Date.now() + 10 * 60_000,
    };
    await saveFor("codex", initialTokens);

    let refreshCalls = 0;
    global.fetch = mock(async () => {
      refreshCalls++;
      await saveFor("codex", {
        accessToken: "winner_access",
        refreshToken: "winner_refresh",
        expiresAt: Date.now() + 60 * 60_000,
      });
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }) as unknown as typeof fetch;

    const tokens = await forceRefreshTokens(initialTokens);

    expect(refreshCalls).toBe(1);
    expect(tokens.accessToken).toBe("winner_access");
    expect(tokens.refreshToken).toBe("winner_refresh");
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
