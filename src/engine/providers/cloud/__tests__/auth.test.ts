import { afterEach, beforeEach, describe, expect, it, type Mock, mock, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeLoginProvider, runLogout } from "@/engine/contract/login.ts";
import * as anthropic from "@/engine/providers/anthropic/auth.ts";
import * as browser from "@/kernel/std/browser.ts";
import { ProviderHttpError } from "@/kernel/std/types/error-meta.ts";
import { isProviderId, providerDisplayName } from "@/kernel/std/types/provider-ids.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";
import {
  type AnthropicTokens,
  loadAll,
  loadFor,
  saveFor,
  subscribeCredentialChanges,
} from "@/kernel/storage/credentials.ts";
import * as cloud from "../auth.ts";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const LOGIN_SCOPE =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const REFRESH_SCOPE =
  "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

function storedTokens(namespace: string): AnthropicTokens {
  return {
    accessToken: `${namespace}-access`,
    refreshToken: `${namespace}-refresh`,
    expiresAt: Date.now() + 3_600_000,
    accountUuid: `${namespace}-account`,
    accountEmail: `${namespace}@example.invalid`,
    organizationName: `${namespace} organization`,
    organizationUuid: `${namespace}-organization`,
  };
}

function tokenResponse(namespace: string): Response {
  return Response.json({
    token_type: "Bearer",
    access_token: `${namespace}-fresh-access`,
    refresh_token: `${namespace}-fresh-refresh`,
    expires_in: 3600,
    scope: REFRESH_SCOPE,
  });
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  const body: unknown = JSON.parse(String(init?.body));
  if (!isRecord(body)) throw new Error("expected a JSON object request body");
  return body;
}

const providers = [
  { id: "anthropic", auth: anthropic },
  { id: "anthropic-cloud", auth: cloud },
] as const;

let credentialHome: string;
let savedConfigDir: string | undefined;
let fetchMock: Mock<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>;
let openBrowserMock: ReturnType<typeof spyOn<typeof browser, "openBrowser">>;

beforeEach(() => {
  savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  credentialHome = mkdtempSync(join(tmpdir(), "otherside-cloud-auth-"));
  process.env.OTHERSIDE_CONFIG_DIR = credentialHome;
  fetchMock = spyOn(globalThis, "fetch");
  fetchMock.mockImplementation(async () => {
    throw new Error("unexpected network request");
  });
  openBrowserMock = spyOn(browser, "openBrowser").mockResolvedValue(undefined);
});

afterEach(() => {
  mock.restore();
  if (savedConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
  rmSync(credentialHome, { recursive: true, force: true });
});

for (const { id, auth } of providers) {
  describe(`${id} OAuth`, () => {
    it("preserves the PKCE authorization and token exchange wire", async () => {
      const untouchedId = id === "anthropic" ? "anthropic-cloud" : "anthropic";
      const untouchedTokens = storedTokens(untouchedId);
      await saveFor(untouchedId, untouchedTokens);
      fetchMock.mockResolvedValue(
        Response.json({
          token_type: "Bearer",
          access_token: `${id}-new-access`,
          refresh_token: `${id}-new-refresh`,
          expires_in: 3600,
          scope: LOGIN_SCOPE,
          organization: { uuid: `${id}-new-org-uuid`, name: `${id}-new-org-name` },
          account: { uuid: `${id}-new-account`, email_address: `${id}@example.invalid` },
        }),
      );

      const flow = await auth.beginLogin();
      const url = new URL(flow.url);
      flow.submitCode(`fake-code#${url.searchParams.get("state")}`);
      const tokens = await flow.result;

      expect(url.origin + url.pathname).toBe("https://claude.com/cai/oauth/authorize");
      const redirectUri = url.searchParams.get("redirect_uri");
      if (!redirectUri) throw new Error("expected a redirect URI");
      expect(redirectUri).toMatch(/^http:\/\/localhost:545\d{2}\/callback$/);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        code: "true",
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: LOGIN_SCOPE,
        code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        code_challenge_method: "S256",
        state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [requestUrl, init] = fetchMock.mock.calls[0]!;
      expect(requestUrl).toBe(TOKEN_URL);
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({
        "Content-Type": "application/json",
        "User-Agent": "axios/1.13.6",
      });
      const body = requestBody(init);
      expect(body).toEqual({
        grant_type: "authorization_code",
        code: "fake-code",
        redirect_uri: redirectUri,
        client_id: CLIENT_ID,
        code_verifier: expect.any(String),
        state: url.searchParams.get("state"),
      });
      if (typeof body.code_verifier !== "string") throw new Error("expected a PKCE verifier");
      expect(createHash("sha256").update(body.code_verifier).digest("base64url")).toBe(
        url.searchParams.get("code_challenge") ?? "",
      );
      expect(tokens.organizationUuid).toBe(`${id}-new-org-uuid`);
      expect(tokens.organizationName).toBe(`${id}-new-org-name`);
      expect(await loadFor(id)).toEqual(tokens);
      expect(await loadFor(untouchedId)).toEqual(untouchedTokens);
      expect(openBrowserMock).not.toHaveBeenCalled();
    });

    it("keeps organization UUID and account identity when refreshing without identity fields", async () => {
      const expired = { ...storedTokens(id), expiresAt: 0 };
      await saveFor(id, expired);
      fetchMock.mockResolvedValue(tokenResponse(id));

      const fresh = await auth.currentTokens();

      expect(fresh).toMatchObject({
        accessToken: `${id}-fresh-access`,
        refreshToken: `${id}-fresh-refresh`,
        organizationUuid: expired.organizationUuid,
        organizationName: expired.organizationName,
        accountUuid: expired.accountUuid,
        accountEmail: expired.accountEmail,
      });
      expect(await loadFor(id)).toEqual(fresh);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]).toEqual([
        TOKEN_URL,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": "axios/1.13.6" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: expired.refreshToken,
            client_id: CLIENT_ID,
            scope: REFRESH_SCOPE,
          }),
        },
      ]);
    });

    it("surfaces invalid_grant without a rotated winner as expired authentication", async () => {
      const expired = { ...storedTokens(id), expiresAt: 0 };
      await saveFor(id, expired);
      const body = JSON.stringify({
        error: "invalid_grant",
        error_description: "Refresh token expired",
      });
      fetchMock.mockResolvedValueOnce(new Response(body, { status: 400 }));
      const error = await auth.currentTokens().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ProviderHttpError);
      expect(error).toMatchObject({ provider: id, status: 401, body });
      expect(await loadFor(id)).toEqual(expired);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    for (const status of [400, 503]) {
      it(`keeps other HTTP ${status} refresh failures unchanged`, async () => {
        await saveFor(id, { ...storedTokens(id), expiresAt: 0 });
        const body = JSON.stringify({ error: "refresh_service_failure" });
        fetchMock.mockResolvedValueOnce(new Response(body, { status }));
        const error = await auth.currentTokens().catch((error: unknown) => error);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(ProviderHttpError);
        expect(error).toMatchObject({
          message: `refresh exchange failed: HTTP ${status}: ${body}`,
        });
      });
    }

    it("rejects a callback state mismatch without requesting or saving tokens", async () => {
      const flow = await auth.beginLogin();
      flow.submitCode("fake-code#wrong-state");

      await expect(flow.result).rejects.toThrow("state mismatch");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await loadFor(id)).toBeNull();
    });
  });
}

describe("Anthropic Cloud namespace isolation", () => {
  it("requires a new cloud login rather than adopting Anthropic credentials", async () => {
    const base = storedTokens("anthropic");
    await saveFor("anthropic", base);

    expect(await cloud.Auth.load()).toBeNull();
    await expect(cloud.currentTokens()).rejects.toThrow(
      "no anthropic-cloud credentials — run `otherside login --provider anthropic-cloud`",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openBrowserMock).not.toHaveBeenCalled();
    expect(await loadFor("anthropic")).toEqual(base);
    expect(await loadFor("anthropic-cloud")).toBeNull();
  });

  it("loads and refreshes its own Auth strategy without touching Anthropic", async () => {
    const base = storedTokens("anthropic");
    const expiredCloud = { ...storedTokens("cloud"), expiresAt: 0 };
    await saveFor("anthropic", base);
    await saveFor("anthropic-cloud", expiredCloud);
    const changed: string[] = [];
    const unsubscribe = subscribeCredentialChanges((id) => changed.push(id));
    fetchMock.mockResolvedValue(tokenResponse("cloud"));

    try {
      const creds = await cloud.Auth.load();
      if (!creds) throw new Error("cloud credentials should be available");
      expect(creds.raw).toEqual(expiredCloud);
      expect(cloud.Auth.isExpired(creds)).toBe(true);
      const refreshed = await cloud.Auth.refresh(creds);
      expect(cloud.Auth.isExpired(refreshed)).toBe(false);
      expect(await cloud.authorizationHeader()).toBe("Bearer cloud-fresh-access");
      expect(changed).toEqual(["anthropic-cloud"]);
      expect(await loadFor("anthropic")).toEqual(base);
      expect(refreshed.raw).toEqual(await loadFor("anthropic-cloud"));
    } finally {
      unsubscribe();
    }
  });

  it("single-flights refreshes within each namespace without joining the other namespace", async () => {
    await saveFor("anthropic", storedTokens("anthropic"));
    await saveFor("anthropic-cloud", storedTokens("cloud"));
    const cloudStarted = Promise.withResolvers<void>();
    const anthropicStarted = Promise.withResolvers<void>();
    const cloudResponse = Promise.withResolvers<Response>();
    const anthropicResponse = Promise.withResolvers<Response>();
    fetchMock.mockImplementation(async (_input, init) => {
      const body = requestBody(init);
      if (body.refresh_token === "cloud-refresh") {
        cloudStarted.resolve();
        return cloudResponse.promise;
      }
      if (body.refresh_token === "anthropic-refresh") {
        anthropicStarted.resolve();
        return anthropicResponse.promise;
      }
      throw new Error("unexpected refresh token");
    });

    const firstCloud = cloud.forceRefreshTokens();
    const secondCloud = cloud.forceRefreshTokens();
    const firstAnthropic = anthropic.forceRefreshTokens();
    const secondAnthropic = anthropic.forceRefreshTokens();
    try {
      expect(secondCloud).toBe(firstCloud);
      expect(secondAnthropic).toBe(firstAnthropic);
      expect(firstCloud).not.toBe(firstAnthropic);
      await Promise.all([cloudStarted.promise, anthropicStarted.promise]);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      cloudResponse.resolve(tokenResponse("cloud"));
      const freshCloud = await firstCloud;
      expect(freshCloud.accessToken).toBe("cloud-fresh-access");
      expect(freshCloud.organizationUuid).toBe("cloud-organization");
      expect((await loadFor("anthropic"))?.accessToken).toBe("anthropic-access");
      anthropicResponse.resolve(tokenResponse("anthropic"));
      const freshAnthropic = await firstAnthropic;
      expect(freshAnthropic.accessToken).toBe("anthropic-fresh-access");
      expect(freshAnthropic.organizationUuid).toBe("anthropic-organization");
      expect(await loadFor("anthropic-cloud")).toEqual(freshCloud);
      expect(await loadFor("anthropic")).toEqual(freshAnthropic);
    } finally {
      cloudResponse.resolve(tokenResponse("cloud"));
      anthropicResponse.resolve(tokenResponse("anthropic"));
      await Promise.allSettled([firstCloud, firstAnthropic]);
    }
  });

  it("does not recover a cloud invalid_grant with the Anthropic winner", async () => {
    const initialCloud = storedTokens("cloud");
    await saveFor("anthropic-cloud", initialCloud);
    fetchMock.mockImplementation(async () => {
      await saveFor("anthropic", storedTokens("anthropic-winner"));
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    });

    await expect(cloud.forceRefreshTokens()).rejects.toMatchObject({
      name: "ProviderHttpError",
      provider: "anthropic-cloud",
      status: 401,
      body: '{"error":"invalid_grant"}',
    });
    expect(await loadFor("anthropic-cloud")).toEqual(initialCloud);
  });

  it("adopts only the cloud winner after invalid_grant and resets the failed refresh flight", async () => {
    await saveFor("anthropic-cloud", storedTokens("cloud"));
    fetchMock.mockResolvedValueOnce(Response.json({ error: "invalid_grant" }, { status: 400 }));
    await expect(cloud.forceRefreshTokens()).rejects.toMatchObject({
      name: "ProviderHttpError",
      provider: "anthropic-cloud",
      status: 401,
      body: '{"error":"invalid_grant"}',
    });

    const winner = storedTokens("cloud-winner");
    fetchMock.mockImplementationOnce(async () => {
      await saveFor("anthropic-cloud", winner);
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    });
    expect(await cloud.forceRefreshTokens()).toEqual(winner);
    expect(await loadFor("anthropic")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("normalizes the experimental provider and logs it out without deleting Anthropic", async () => {
    expect(isProviderId("anthropic-cloud")).toBe(true);
    expect(providerDisplayName("anthropic-cloud")).toBe("Anthropic Cloud");
    expect(normalizeLoginProvider("  ANTHROPIC-CLOUD  ")).toBe("anthropic-cloud");
    expect(normalizeLoginProvider("anthropic")).toBe("anthropic");
    expect(normalizeLoginProvider("claude-cloud")).toBeNull();
    expect(normalizeLoginProvider(null)).toBeNull();
    const base = storedTokens("anthropic");
    await saveFor("anthropic", base);
    await saveFor("anthropic-cloud", storedTokens("cloud"));

    expect(await runLogout("anthropic-cloud")).toEqual([
      "Cleared cached credentials for anthropic-cloud.",
    ]);
    expect(await loadAll()).toEqual({ anthropic: base });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openBrowserMock).not.toHaveBeenCalled();
  });
});
