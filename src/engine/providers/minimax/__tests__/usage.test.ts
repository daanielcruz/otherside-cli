import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearRoutingUsage,
  clearUsageLimits,
  getRoutingUsage,
  stopUsageSweepTimerForTests,
} from "@/engine/session/usage/limits.ts";
import { saveFor } from "@/kernel/storage/credentials.ts";
import { applyMinimaxQuotaWarning, fetchMinimaxUsage, parseMinimaxUsagePayload } from "../usage.ts";

let configDir: string;
let originalConfigDir: string | undefined;
const originalFetch = global.fetch;

const MINIMAX_REMAINS_PAYLOAD = {
  plan_level: "pro",
  model_remains: [
    {
      model_name: "MiniMax-M2",
      current_interval_remaining_percent: 75,
      end_time: 1_783_153_005_847,
      current_weekly_remaining_percent: 40,
      weekly_end_time: 1_783_502_363_988,
    },
    {
      model_name: "MiniMax-M2.1",
      current_interval_remaining_percent: 100,
      end_time: 1_783_153_005_847,
      current_weekly_status: 3,
      weekly_end_time: 1_783_502_363_988,
    },
  ],
} as const;

describe("MiniMax usage", () => {
  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "minimax-usage-test-"));
    originalConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = configDir;
    await saveFor("minimax", { apiKey: "minimax-test-key" });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalConfigDir === undefined) {
      delete process.env.OTHERSIDE_CONFIG_DIR;
    } else {
      process.env.OTHERSIDE_CONFIG_DIR = originalConfigDir;
    }
    rmSync(configDir, { recursive: true, force: true });
    clearRoutingUsage("minimax");
    clearUsageLimits();
    stopUsageSweepTimerForTests();
  });

  it("parses the complete Token Plan remains wire shape", () => {
    expect(parseMinimaxUsagePayload(MINIMAX_REMAINS_PAYLOAD)).toEqual({
      level: "pro",
      windows: [
        {
          label: "MiniMax-M2 · 5-hour",
          limit: { utilization: 25, resetsAt: "2026-07-04T08:16:45.847Z" },
        },
        {
          label: "MiniMax-M2 · weekly",
          limit: { utilization: 60, resetsAt: "2026-07-08T09:19:23.988Z" },
        },
        {
          label: "MiniMax-M2.1 · 5-hour",
          limit: { utilization: 0, resetsAt: "2026-07-04T08:16:45.847Z" },
        },
        {
          label: "MiniMax-M2.1 · weekly",
          limit: { utilization: 0, resetsAt: "2026-07-08T09:19:23.988Z" },
          detail: "unlimited",
        },
      ],
    });
  });

  it("parses explicit exhaustion and routes it through the quota gate", () => {
    const usage = parseMinimaxUsagePayload({
      model_remains: [
        {
          model_name: "MiniMax-M2",
          current_interval_remaining_percent: 0,
          current_weekly_remaining_percent: 0,
        },
      ],
    });

    expect(usage?.windows.map((window) => window.limit.utilization)).toEqual([100, 100]);
    applyMinimaxQuotaWarning(usage);
    expect(getRoutingUsage("minimax")?.balanceStatus).toBe("exhausted");
  });

  it("fails closed on missing and malformed remains fields", () => {
    expect(parseMinimaxUsagePayload(null)).toBeNull();
    expect(parseMinimaxUsagePayload({})).toBeNull();
    expect(parseMinimaxUsagePayload({ model_remains: {} })).toBeNull();
    expect(
      parseMinimaxUsagePayload({
        model_remains: [
          null,
          "invalid",
          {
            current_interval_remaining_percent: "0",
            current_weekly_remaining_percent: Number.NaN,
          },
        ],
      }),
    ).toBeNull();
  });

  it("leaves reset timestamps null when epoch milliseconds are invalid", () => {
    expect(
      parseMinimaxUsagePayload({
        model_remains: [
          {
            current_interval_remaining_percent: 50,
            end_time: -1,
            current_weekly_remaining_percent: 50,
            weekly_end_time: Number.MAX_VALUE,
          },
        ],
      })?.windows.map((window) => window.limit.resetsAt),
    ).toEqual([null, null]);
  });

  it("requests the documented Token Plan endpoint and headers", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenInit = init;
      return Promise.resolve(new Response(JSON.stringify({})));
    }) as unknown as typeof fetch;

    await expect(fetchMinimaxUsage()).resolves.toBeNull();

    expect(seenUrl).toBe("https://www.minimax.io/v1/token_plan/remains");
    expect(seenInit?.method).toBe("GET");
    expect(seenInit?.headers).toEqual({
      Authorization: "Bearer minimax-test-key",
      "Content-Type": "application/json",
    });
  });
});
