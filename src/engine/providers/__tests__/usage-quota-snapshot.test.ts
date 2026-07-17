import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import { applyKimiQuotaWarning } from "@/engine/providers/kimi/usage.ts";
import { fetchUsageSnapshot } from "@/engine/providers/usage-quota-snapshot.ts";
import {
  clearRoutingUsage,
  getRoutingUsage,
  stopUsageSweepTimerForTests,
  warningForProvider,
} from "@/engine/session/usage/limits.ts";

registerAllProviders();

const originalFetch = global.fetch;
let configDir = "";
let previousConfigDir: string | undefined;
let previousApiKey: string | undefined;

beforeEach(async () => {
  clearRoutingUsage();
  applyKimiQuotaWarning(null);
  previousConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  previousApiKey = process.env.OTHERSIDE_KIMI_API_KEY;
  configDir = await mkdtemp(join(tmpdir(), "otherside-usage-snapshot-"));
  process.env.OTHERSIDE_CONFIG_DIR = configDir;
  process.env.OTHERSIDE_KIMI_API_KEY = "test-key";
  await Bun.write(
    join(configDir, "credentials.json"),
    JSON.stringify({ kimi: { apiKey: "test-key" } }),
  );
  global.fetch = mock(async () => Response.json({ unexpected: true })) as unknown as typeof fetch;
});

afterEach(async () => {
  global.fetch = originalFetch;
  if (previousConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = previousConfigDir;
  if (previousApiKey === undefined) delete process.env.OTHERSIDE_KIMI_API_KEY;
  else process.env.OTHERSIDE_KIMI_API_KEY = previousApiKey;
  applyKimiQuotaWarning(null);
  clearRoutingUsage();
  stopUsageSweepTimerForTests();
  await rm(configDir, { recursive: true, force: true });
});

describe("fetchUsageSnapshot Kimi quota state", () => {
  it("clears stale warning and routing state when the payload is null", async () => {
    applyKimiQuotaWarning({
      summary: { label: "Weekly limit", used: 100, limit: 100 },
      limits: [],
    });
    expect(warningForProvider("kimi")).not.toBeNull();
    expect(getRoutingUsage("kimi")).not.toBeNull();

    const snapshot = await fetchUsageSnapshot({});
    const provider = snapshot.providers.find((entry) => entry.id === "kimi");

    expect(provider?.bars).toEqual([]);
    expect(provider?.warning).toBeNull();
    expect(warningForProvider("kimi")).toBeNull();
    expect(getRoutingUsage("kimi")).toBeNull();
  });
});
