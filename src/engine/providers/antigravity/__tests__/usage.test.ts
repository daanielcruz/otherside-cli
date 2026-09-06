import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { registerProviderConfig } from "@/engine/contract/registry.ts";
import * as authModule from "@/engine/providers/antigravity/auth.ts";
import { config as antigravityConfig } from "@/engine/providers/antigravity/config.ts";
import * as fingerprintModule from "@/engine/providers/antigravity/fingerprint.ts";

const realAuthModule = { ...authModule };
const realFingerprintModule = { ...fingerprintModule };

mock.module("@/engine/providers/antigravity/auth.ts", () => ({
  ...realAuthModule,
  currentTokens: async () => ({
    accessToken: "mock-access-token",
    refreshToken: "mock-refresh-token",
    expiresAt: Date.now() + 3600000,
    scopes: [],
  }),
  resolveProjectId: async () => "mock-project-id",
}));

mock.module("@/engine/providers/antigravity/fingerprint.ts", () => ({
  ...realFingerprintModule,
  backendHost: () => "https://daily-cloudcode-pa.googleapis.com",
  userAgent: () =>
    "antigravity/cli/1.1.13 (aidev_client; os_type=darwin; arch=arm64; auth_method=consumer)",
}));

import {
  clearRoutingUsage,
  clearUsageLimits,
  getRoutingUsage,
  warningForProvider,
} from "@/engine/session/usage/limits.ts";
import { providerRouteability } from "@/engine/session/usage/provider-routeability.ts";
import {
  applyAntigravityQuotaWarning,
  fetchAntigravityUsage,
  parseGoogleOneCredits,
  parseQuotaSummary,
} from "../usage.ts";

const originalFetch = global.fetch;

const QUOTA_SUMMARY_PAYLOAD = {
  groups: [
    {
      displayName: "Gemini Quota",
      buckets: [
        {
          displayName: "daily",
          remainingFraction: 0.8,
          resetTime: "2026-07-03T01:29:59Z",
        },
      ],
    },
  ],
};

const ELIGIBILITY_PAYLOAD = {
  paidTier: {
    availableCredits: [
      {
        creditType: "GOOGLE_ONE_AI",
        creditAmount: "123",
        minimumCreditAmountForUsage: "1",
      },
    ],
  },
};

describe("antigravity usage", () => {
  let fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];

  beforeAll(() => registerProviderConfig(antigravityConfig));

  beforeEach(() => {
    fetchCalls = [];
    global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      const payload = String(url).includes("loadCodeAssist")
        ? ELIGIBILITY_PAYLOAD
        : QUOTA_SUMMARY_PAYLOAD;
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    clearRoutingUsage();
    clearUsageLimits();
  });

  afterAll(() => {
    mock.module("@/engine/providers/antigravity/auth.ts", () => realAuthModule);
    mock.module("@/engine/providers/antigravity/fingerprint.ts", () => realFingerprintModule);
  });

  it("POST retrieveUserQuotaSummary with project, UA, and auth headers", async () => {
    const result = await fetchAntigravityUsage();
    expect(result).not.toBeNull();
    expect(fetchCalls.length).toBe(2);

    const call = fetchCalls.find((c) => c.url.includes("retrieveUserQuotaSummary"))!;
    expect(call.url).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    );
    expect(call.init?.method).toBe("POST");

    const body = JSON.parse(call.init?.body as string);
    expect(body).toEqual({ project: "mock-project-id" });

    const headers = call.init?.headers as Record<string, string>;
    expect(headers).toBeDefined();
    expect(headers.Authorization).toBe("Bearer mock-access-token");
    expect(headers["User-Agent"]).toBe(
      "antigravity/cli/1.1.13 (aidev_client; os_type=darwin; arch=arm64; auth_method=consumer)",
    );
    expect(headers["User-Agent"]).toMatch(/1\.1\.13/);
  });

  it("POST loadCodeAssist eligibility check and surfaces the credit balance", async () => {
    const result = await fetchAntigravityUsage();
    expect(result?.creditBalance).toBe(123);

    const call = fetchCalls.find((c) => c.url.includes("loadCodeAssist"))!;
    expect(call.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
    expect(call.init?.method).toBe("POST");
    expect(JSON.parse(call.init?.body as string)).toEqual({
      metadata: { ideType: "ANTIGRAVITY" },
      mode: "FULL_ELIGIBILITY_CHECK",
    });
    const headers = call.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer mock-access-token");
  });

  it("keeps the quota summary when the credit fetch fails", async () => {
    global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      if (String(url).includes("loadCodeAssist")) {
        return Promise.resolve(new Response("boom", { status: 500 }));
      }
      return Promise.resolve(new Response(JSON.stringify(QUOTA_SUMMARY_PAYLOAD), { status: 200 }));
    }) as unknown as typeof fetch;

    const result = await fetchAntigravityUsage();
    expect(result).not.toBeNull();
    expect(result?.groups.length).toBe(1);
    expect(result?.creditBalance).toBeNull();
  });

  describe("parseGoogleOneCredits (explicit row or unknown, never zero)", () => {
    it("reads an explicit GOOGLE_ONE_AI decimal-string amount", () => {
      expect(parseGoogleOneCredits(ELIGIBILITY_PAYLOAD)).toBe(123);
    });

    it('explicit "0" is a known-exhausted balance, not unknown', () => {
      expect(
        parseGoogleOneCredits({
          paidTier: { availableCredits: [{ creditType: "GOOGLE_ONE_AI", creditAmount: "0" }] },
        }),
      ).toBe(0);
    });

    it("missing paidTier, matching row, or valid amount stays unknown", () => {
      expect(parseGoogleOneCredits(null)).toBeNull();
      expect(parseGoogleOneCredits({})).toBeNull();
      expect(parseGoogleOneCredits({ paidTier: {} })).toBeNull();
      expect(parseGoogleOneCredits({ paidTier: { availableCredits: [] } })).toBeNull();
      expect(
        parseGoogleOneCredits({
          paidTier: { availableCredits: [{ creditType: "OTHER", creditAmount: "9" }] },
        }),
      ).toBeNull();
      expect(
        parseGoogleOneCredits({
          paidTier: { availableCredits: [{ creditType: "GOOGLE_ONE_AI", creditAmount: "abc" }] },
        }),
      ).toBeNull();
      expect(
        parseGoogleOneCredits({
          paidTier: { availableCredits: [{ creditType: "GOOGLE_ONE_AI" }] },
        }),
      ).toBeNull();
    });
  });

  it("truncates non-2xx HTTP errors", async () => {
    global.fetch = mock(() => {
      return Promise.resolve(new Response("a".repeat(300), { status: 500 }));
    }) as unknown as typeof fetch;

    await expect(fetchAntigravityUsage()).rejects.toThrow(`HTTP 500: ${"a".repeat(239)}…`);

    global.fetch = mock(() => {
      return Promise.resolve(new Response("short error", { status: 400 }));
    }) as unknown as typeof fetch;

    await expect(fetchAntigravityUsage()).rejects.toThrow("HTTP 400: short error");
  });

  it("handles malformed or null payload in parseQuotaSummary", () => {
    expect(parseQuotaSummary(null)).toBeNull();
    expect(parseQuotaSummary(undefined)).toBeNull();
    expect(parseQuotaSummary(123)).toBeNull();
    expect(parseQuotaSummary("string")).toBeNull();
    expect(parseQuotaSummary([])).toBeNull();
    expect(parseQuotaSummary({})).toBeNull();
    expect(parseQuotaSummary({ groups: null })).toBeNull();
    expect(parseQuotaSummary({ groups: {} })).toBeNull();
    expect(parseQuotaSummary({ groups: [] })).toBeNull();

    expect(
      parseQuotaSummary({ groups: [{ displayName: "", buckets: [{ displayName: "B" }] }] }),
    ).toBeNull();
    expect(parseQuotaSummary({ groups: [{ displayName: "G", buckets: [] }] })).toBeNull();
    expect(
      parseQuotaSummary({ groups: [{ displayName: "G", buckets: [{ displayName: "" }] }] }),
    ).toBeNull();
  });

  it("clamps remainingFraction between 0 and 1", () => {
    const payload = {
      groups: [
        {
          displayName: "Group",
          buckets: [
            { displayName: "Underflow", remainingFraction: -0.2 },
            { displayName: "Overflow", remainingFraction: 1.2 },
            { displayName: "Valid", remainingFraction: 0.4 },
          ],
        },
      ],
    };
    const parsed = parseQuotaSummary(payload);
    expect(parsed).not.toBeNull();
    const buckets = parsed!.groups[0]!.buckets;
    expect(buckets[0]!.remainingFraction).toBe(0);
    expect(buckets[1]!.remainingFraction).toBe(1);
    expect(buckets[2]!.remainingFraction).toBe(0.4);
  });

  it("calculates utilization percentage and maps resetTime to resetsAt", () => {
    const payload = {
      groups: [
        {
          displayName: "Group",
          buckets: [
            { displayName: "Bucket 1", remainingFraction: 0.25, resetTime: "2026-07-03T01:29:59Z" },
            { displayName: "Bucket 2", remainingFraction: null, resetTime: null },
          ],
        },
      ],
    };
    const parsed = parseQuotaSummary(payload);
    expect(parsed).not.toBeNull();
    const buckets = parsed!.groups[0]!.buckets;
    expect(buckets[0]!.utilization).toBe(75);
    expect(buckets[0]!.resetsAt).toBe("2026-07-03T01:29:59Z");
    expect(buckets[1]!.utilization).toBeNull();
    expect(buckets[1]!.resetsAt).toBeNull();
  });

  describe("applyAntigravityQuotaWarning (provider+scope SoT, apply is model-independent)", () => {
    afterEach(() => {
      clearRoutingUsage();
      clearUsageLimits();
    });

    const twoFamilyUsage = (geminiPct: number, claudeGptPct: number) => ({
      groups: [
        {
          displayName: "Gemini Quota",
          description: "",
          buckets: [
            {
              bucketId: "gemini-bucket",
              displayName: "Gemini Bucket",
              remainingFraction: 1 - geminiPct / 100,
              utilization: geminiPct,
              resetsAt: null,
            },
          ],
        },
        {
          displayName: "Claude Quota",
          description: "",
          buckets: [
            {
              bucketId: "claude-bucket",
              displayName: "Claude Bucket",
              remainingFraction: 1 - claudeGptPct / 100,
              utilization: claudeGptPct,
              resetsAt: null,
            },
          ],
        },
      ],
    });

    it("atomically stores both family scopes from a single fetch; apply ignores the model argument", () => {
      // A second positional model argument is accepted (compat) but must not
      // change which families get stored — both are always represented.
      applyAntigravityQuotaWarning(twoFamilyUsage(95, 80), "claude-3-5-sonnet");
      // Legacy provider-wide getter derives the WORST across every family scope.
      expect(getRoutingUsage("antigravity")?.utilizationPct).toBe(95);

      const claudeRoute = providerRouteability("antigravity", undefined, "claude-3-5-sonnet");
      const gptRoute = providerRouteability("antigravity", undefined, "gpt-4o");
      const geminiRoute = providerRouteability("antigravity", undefined, "gemini-1.5-pro");
      expect(claudeRoute.routing.state.utilizationPct).toBe(80);
      expect(gptRoute.routing.state.utilizationPct).toBe(80);
      expect(geminiRoute.routing.state.utilizationPct).toBe(95);
    });

    it("100% in one family blocks only its matching model; the other family stays usable", () => {
      applyAntigravityQuotaWarning(twoFamilyUsage(100, 50));
      expect(providerRouteability("antigravity", undefined, "gemini-1.5-pro").usable).toBe(false);
      expect(providerRouteability("antigravity", undefined, "claude-3-5-sonnet").usable).toBe(true);
      expect(providerRouteability("antigravity", undefined, "gpt-4o").usable).toBe(true);
    });

    it("marks a fully spent bucket as hit (error severity), formatted through the central template", () => {
      applyAntigravityQuotaWarning(twoFamilyUsage(100, 10));
      expect(getRoutingUsage("antigravity")?.balanceStatus).toBe("exhausted");
      expect(warningForProvider("antigravity")?.severity).toBe("error");
      const message = warningForProvider("antigravity")?.message ?? "";
      expect(message.startsWith("[Antigravity] 100%")).toBe(true);
      expect(message).toBe("[Antigravity] 100% Gemini · resets unknown");
    });

    it("clears both families when usage is null", () => {
      applyAntigravityQuotaWarning(twoFamilyUsage(100, 50));
      expect(getRoutingUsage("antigravity")).not.toBeNull();
      applyAntigravityQuotaWarning(null);
      expect(getRoutingUsage("antigravity")).toBeNull();
      expect(warningForProvider("antigravity")).toBeNull();
    });

    it("stale scope deletion: a family absent from a later fetch stops gating its model", () => {
      applyAntigravityQuotaWarning(twoFamilyUsage(100, 50));
      expect(providerRouteability("antigravity", undefined, "gemini-1.5-pro").usable).toBe(false);

      // Next fetch reports only the Claude/GPT family: the stale Gemini scope
      // must be dropped by the atomic replace, not linger as a stale block.
      applyAntigravityQuotaWarning({
        groups: [
          {
            displayName: "Claude Quota",
            description: "",
            buckets: [
              {
                bucketId: "claude-bucket",
                displayName: "Claude Bucket",
                remainingFraction: 0.5,
                utilization: 50,
                resetsAt: null,
              },
            ],
          },
        ],
      });
      const geminiRoute = providerRouteability("antigravity", undefined, "gemini-1.5-pro");
      expect(geminiRoute.usable).toBe(true);
      expect(geminiRoute.routing.source).toBe("unobserved");
    });
  });
});
