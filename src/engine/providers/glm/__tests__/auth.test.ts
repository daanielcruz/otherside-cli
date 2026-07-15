import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveFor } from "@/kernel/storage/credentials.ts";
import { beginLogin, currentGlmChatCredential } from "../auth.ts";

let configDir: string;
const originalFetch = global.fetch;

describe("glm loopback oauth", () => {
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "glm-oauth-test-"));
    process.env.OTHERSIDE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.OTHERSIDE_CONFIG_DIR;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("uses a localhost redirect_uri and exchanges with the same redirect_uri", async () => {
    let tokenBody = "";
    global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("oauth/token")) {
        tokenBody = String(init?.body ?? "");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                token: "jwt.new",
                zai: { access_token: "zai.new" },
                user: { user_id: "u1", email: "u@example.test" },
              },
            }),
            { status: 200 },
          ),
        );
      }
      if (urlStr.includes("auth/z/login")) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: { access_token: "biz.token" } }), { status: 200 }),
        );
      }
      if (urlStr.includes("getCustomerInfo")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                organizations: [{ organizationId: "org-1", projects: [{ projectId: "proj-1" }] }],
              },
            }),
            { status: 200 },
          ),
        );
      }
      if (urlStr.includes("api_keys/copy")) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: { apiKey: "ak-test", secretKey: "sk-test" } }), {
            status: 200,
          }),
        );
      }
      if (urlStr.includes("api_keys")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [{ apiKey: "ak-test", secretKey: "*****", name: "zcode-api-key" }],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 404 }));
    }) as unknown as typeof fetch;

    const flow = await beginLogin();
    const authorizeUrl = new URL(flow.url);
    const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
    const state = authorizeUrl.searchParams.get("state");

    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      "https://chat.z.ai/auth/oauth/authorize",
    );
    expect(authorizeUrl.searchParams.get("client_id")).toBe("client_P8X5CMWmlaRO9gyO-KSqtg");
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/glm\/oauth\/callback$/);
    expect(state).toBeTruthy();

    flow.submitCode(`zcode-code#${state}`);
    const creds = await flow.result;

    expect(creds).toEqual({
      zcodeJwtToken: "jwt.new",
      zaiAccessToken: "zai.new",
      apiKey: "ak-test.sk-test",
      user: { user_id: "u1", email: "u@example.test" },
    });
    expect(JSON.parse(tokenBody)).toEqual({
      provider: "zai",
      code: "zcode-code",
      redirect_uri: redirectUri,
      state,
    });
  });

  it("uses a cached project API key even after the OAuth token expiry", async () => {
    await saveFor("glm", {
      zcodeJwtToken: "jwt.old",
      zaiAccessToken: "zai.old",
      apiKey: "ak-test.sk-test",
      expiresAt: 1,
    });

    await expect(currentGlmChatCredential()).resolves.toBe("ak-test.sk-test");
  });
});
