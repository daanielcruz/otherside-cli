import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { auxiliaryModelFor } from "@/engine/model/tier/tiers.ts";
import * as authModule from "@/engine/providers/anthropic/auth.ts";
import { DEFAULT_CONFIG } from "@/kernel/config/config.ts";
import type { AnthropicTokens } from "@/kernel/storage/credentials.ts";
import * as credentialsModule from "@/kernel/storage/credentials.ts";
import { buildResumedSession } from "@/main.ts";
import { anthropicWireModelId } from "../_infra/fingerprint.ts";
import { anthropicUserIdMetadata } from "../metadata.ts";
import { probeQuotaStatus } from "../quota-probe.ts";

type AnthropicApiKeyCreds = { apiKey: string };
type ResumedSessionBroker = Parameters<typeof buildResumedSession>[0]["broker"];

function makeAnthropicBroker(): ResumedSessionBroker {
  return {
    read: () => ({
      provider: "anthropic",
      model: "claude-opus-4-8",
      effort: "high",
      fastMode: false,
      permissionMode: "accept-edits",
    }),
  } as ResumedSessionBroker;
}

// Capture original credentials exports
const realCredentialsPath = credentialsModule.credentialsPath;
const realHasCredential = credentialsModule.hasCredential;
const realHasConfiguredCredential = credentialsModule.hasConfiguredCredential;
const realHasCodexCredentialSync = credentialsModule.hasCodexCredentialSync;
const realPROVIDER_FALLBACK_ORDER = credentialsModule.PROVIDER_FALLBACK_ORDER;
const realFirstLoggedProvider = credentialsModule.firstLoggedProvider;
const realLoadAll = credentialsModule.loadAll;
const realLoadFor = credentialsModule.loadFor;
const realSaveFor = credentialsModule.saveFor;
const realDeleteFor = credentialsModule.deleteFor;

// Capture original auth exports
const realLogin = authModule.login;
const realBeginLogin = authModule.beginLogin;
const realLoginManual = authModule.loginManual;
const realAuth = authModule.Auth;
const realAuthorizationHeader = authModule.authorizationHeader;

let mockCreds: AnthropicTokens | AnthropicApiKeyCreds | null = null;
mock.module("@/kernel/storage/credentials.ts", () => ({
  credentialsPath: realCredentialsPath,
  hasCredential: realHasCredential,
  hasConfiguredCredential: realHasConfiguredCredential,
  hasCodexCredentialSync: realHasCodexCredentialSync,
  PROVIDER_FALLBACK_ORDER: realPROVIDER_FALLBACK_ORDER,
  firstLoggedProvider: realFirstLoggedProvider,
  loadAll: realLoadAll,
  loadFor: async (slug: Parameters<typeof realLoadFor>[0]) => {
    if (slug === "anthropic") {
      return mockCreds;
    }
    return realLoadFor(slug);
  },
  saveFor: realSaveFor,
  deleteFor: realDeleteFor,
}));

const mockAuthHeader = "Bearer token-123";
mock.module("@/engine/providers/anthropic/auth.ts", () => ({
  login: realLogin,
  beginLogin: realBeginLogin,
  loginManual: realLoginManual,
  Auth: realAuth,
  authorizationHeader: async () => {
    return mockAuthHeader;
  },
}));

afterAll(() => {
  mock.module("@/kernel/storage/credentials.ts", () => ({
    credentialsPath: realCredentialsPath,
    hasCredential: realHasCredential,
    hasConfiguredCredential: realHasConfiguredCredential,
    hasCodexCredentialSync: realHasCodexCredentialSync,
    PROVIDER_FALLBACK_ORDER: realPROVIDER_FALLBACK_ORDER,
    firstLoggedProvider: realFirstLoggedProvider,
    loadAll: realLoadAll,
    loadFor: realLoadFor,
    saveFor: realSaveFor,
    deleteFor: realDeleteFor,
  }));
  mock.module("@/engine/providers/anthropic/auth.ts", () => ({
    login: realLogin,
    beginLogin: realBeginLogin,
    loginManual: realLoginManual,
    Auth: realAuth,
    authorizationHeader: realAuthorizationHeader,
  }));
});

describe("quota-probe", () => {
  const originalFetch = global.fetch;
  let fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];

  beforeEach(() => {
    fetchCalls = [];
    mockCreds = null;
    global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: url instanceof Request ? url.url : String(url), init });
      return Promise.resolve(
        new Response("{}", {
          status: 200,
          headers: new Headers({
            "anthropic-ratelimit-unified-status": "allowed",
            "anthropic-ratelimit-unified-reset": "123456",
          }),
        }),
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should serialize the request body correctly", async () => {
    mockCreds = {
      accessToken: "token-123",
      refreshToken: "refresh-123",
      expiresAt: Date.now() + 60000,
    };

    const broker = makeAnthropicBroker();

    await probeQuotaStatus(broker);

    expect(fetchCalls.length).toBe(1);
    const call = fetchCalls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    const init = call.init;
    if (!init) throw new Error("missing fetch init");
    expect(init.method).toBe("POST");

    const requestBody = init.body;
    if (typeof requestBody !== "string") throw new Error("request body was not a string");

    const parsedBody = JSON.parse(requestBody);
    expect(parsedBody.max_tokens).toBe(1);
    expect(parsedBody.messages).toEqual([{ role: "user", content: "quota" }]);

    const keys = Object.keys(parsedBody);
    expect(keys).toEqual(["max_tokens", "messages", "metadata", "model"]);

    const userIdObj = JSON.parse(parsedBody.metadata.user_id);
    const sessionId = userIdObj.session_id;

    const expected = JSON.stringify({
      max_tokens: 1,
      messages: [{ role: "user", content: "quota" }],
      metadata: {
        user_id: anthropicUserIdMetadata(sessionId),
      },
      model: anthropicWireModelId(auxiliaryModelFor("anthropic"), false),
    });
    expect(requestBody).toBe(expected);
  });

  it("should block request if api-key account", async () => {
    mockCreds = {
      apiKey: "sk-ant-123",
    };

    const broker = makeAnthropicBroker();

    await probeQuotaStatus(broker);

    expect(fetchCalls.length).toBe(0);
  });

  it("should not trigger probe in print mode", async () => {
    mockCreds = {
      accessToken: "token-123",
      refreshToken: "refresh-123",
      expiresAt: Date.now() + 60000,
    };

    const broker = makeAnthropicBroker();

    await buildResumedSession({
      effectiveResumeId: null,
      resumeRecords: [],
      resumeUsageRecords: [],
      chainHead: null,
      isResume: false,
      broker,
      cfg: DEFAULT_CONFIG,
      isPrint: true,
    });

    expect(fetchCalls.length).toBe(0);
  });

  it("should trigger probe in non-print mode", async () => {
    mockCreds = {
      accessToken: "token-123",
      refreshToken: "refresh-123",
      expiresAt: Date.now() + 60000,
    };

    const broker = makeAnthropicBroker();

    await buildResumedSession({
      effectiveResumeId: null,
      resumeRecords: [],
      resumeUsageRecords: [],
      chainHead: null,
      isResume: false,
      broker,
      cfg: DEFAULT_CONFIG,
      isPrint: false,
    });

    // Wait for the fire-and-forget probe request to be made
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchCalls.length).toBe(1);
  });
});
