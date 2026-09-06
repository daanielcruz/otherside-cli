import { afterEach, describe, expect, it, mock } from "bun:test";
import * as authModule from "@/engine/providers/deepseek/auth.ts";

const realAuthModule = { ...authModule };

mock.module("@/engine/providers/deepseek/auth.ts", () => ({
  ...realAuthModule,
  currentApiKey: async () => "deepseek-placeholder-key",
}));

import {
  fetchDeepseekBalance,
  parseDeepseekBalancePayload,
} from "@/engine/providers/deepseek/usage.ts";

const originalFetch = global.fetch;
const DEEPSEEK_BALANCE_PAYLOAD = {
  is_available: true,
  balance_infos: [
    {
      currency: "USD",
      total_balance: "12.50",
      granted_balance: "2.50",
      topped_up_balance: "10.00",
    },
    {
      currency: "CNY",
      total_balance: "8.25",
      granted_balance: "8.25",
      topped_up_balance: "0.00",
    },
  ],
} as const;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("DeepSeek balance usage", () => {
  it("parses the documented balance response wire shape", () => {
    expect(parseDeepseekBalancePayload(DEEPSEEK_BALANCE_PAYLOAD)).toEqual({
      isAvailable: true,
      rows: [
        {
          currency: "USD",
          totalBalance: 12.5,
          grantedBalance: 2.5,
          toppedUpBalance: 10,
        },
        {
          currency: "CNY",
          totalBalance: 8.25,
          grantedBalance: 8.25,
          toppedUpBalance: 0,
        },
      ],
    });
  });

  it("preserves explicit unavailable and exhausted balances", () => {
    expect(
      parseDeepseekBalancePayload({
        is_available: false,
        balance_infos: [
          {
            currency: "USD",
            total_balance: "0.00",
            granted_balance: "0.00",
            topped_up_balance: "0.00",
          },
        ],
      }),
    ).toEqual({
      isAvailable: false,
      rows: [{ currency: "USD", totalBalance: 0, grantedBalance: 0, toppedUpBalance: 0 }],
    });
  });

  it("returns null for non-object payloads and skips malformed rows", () => {
    expect(parseDeepseekBalancePayload(null)).toBeNull();
    expect(parseDeepseekBalancePayload([])).toBeNull();
    expect(
      parseDeepseekBalancePayload({
        is_available: "true",
        balance_infos: [null, "invalid"],
      }),
    ).toEqual({ isAvailable: false, rows: [] });
  });

  it("drops a row missing any balance field instead of fabricating zeros", () => {
    expect(
      parseDeepseekBalancePayload({
        is_available: true,
        balance_infos: [
          { currency: "USD" },
          { currency: "USD", total_balance: "3.00", granted_balance: "oops" },
          {
            currency: "USD",
            total_balance: "12.50",
            granted_balance: "2.50",
            topped_up_balance: "10.00",
          },
        ],
      }),
    ).toEqual({
      isAvailable: true,
      rows: [{ currency: "USD", totalBalance: 12.5, grantedBalance: 2.5, toppedUpBalance: 10 }],
    });
  });

  it("requests the documented balance endpoint and authorization headers", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), ...(init !== undefined ? { init } : {}) });
      return Promise.resolve(new Response(JSON.stringify(DEEPSEEK_BALANCE_PAYLOAD)));
    }) as unknown as typeof fetch;

    await expect(fetchDeepseekBalance()).resolves.toEqual(
      parseDeepseekBalancePayload(DEEPSEEK_BALANCE_PAYLOAD),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "https://api.deepseek.com/user/balance",
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer deepseek-placeholder-key",
        },
      },
    });
  });
});
