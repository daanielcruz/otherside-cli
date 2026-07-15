import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveFor } from "@/kernel/storage/credentials.ts";
import { fetchGlmUsage, parseGlmUsagePayload } from "../usage.ts";

let configDir: string;
let originalConfigDir: string | undefined;
const originalFetch = global.fetch;

describe("glm usage", () => {
  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "glm-usage-test-"));
    originalConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = configDir;
    await saveFor("glm", { zcodeJwtToken: "jwt.usage", apiKey: "ak-test.sk-test" });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalConfigDir === undefined) {
      delete process.env.OTHERSIDE_CONFIG_DIR;
    } else {
      process.env.OTHERSIDE_CONFIG_DIR = originalConfigDir;
    }
    rmSync(configDir, { recursive: true, force: true });
  });

  it("fetches Z.AI monitor quota with the project API key", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenInit = init;
      return Promise.resolve(new Response(JSON.stringify({ code: 200, data: { limits: [] } })));
    }) as unknown as typeof fetch;

    await expect(fetchGlmUsage()).resolves.toBeNull();

    expect(seenUrl).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
    expect(seenInit?.method).toBe("GET");
    expect(seenInit?.body).toBeUndefined();
    expect(seenInit?.headers).toEqual({ authorization: "ak-test.sk-test" });
  });

  it("throws on body-level Z.AI monitor errors", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 500, msg: "quota unavailable", success: false }), {
          status: 200,
        }),
      ),
    ) as unknown as typeof fetch;

    await expect(fetchGlmUsage()).rejects.toThrow("glm usage 500: quota unavailable");
  });

  it("parses Z.AI monitor quota limits into quota windows", () => {
    expect(
      parseGlmUsagePayload({
        code: 200,
        data: {
          level: "max",
          limits: [
            {
              type: "TOKENS_LIMIT",
              unit: 3,
              number: 5,
              percentage: 3,
              nextResetTime: 1_783_153_005_847,
            },
            {
              type: "TOKENS_LIMIT",
              unit: 6,
              number: 1,
              percentage: 39,
              nextResetTime: 1_783_502_363_988,
            },
            {
              type: "TIME_LIMIT",
              unit: 5,
              number: 1,
              usage: 4_000,
              currentValue: 118,
              percentage: 2,
              nextResetTime: 1_784_279_963_990,
            },
          ],
        },
      }),
    ).toEqual({
      level: "GLM Coding Max",
      windows: [
        {
          label: "5-hour prompt pool",
          limit: { utilization: 3, resetsAt: "2026-07-04T08:16:45.847Z" },
          detail: undefined,
        },
        {
          label: "Weekly quota",
          limit: { utilization: 39, resetsAt: "2026-07-08T09:19:23.988Z" },
          detail: undefined,
        },
        {
          label: "MCP quota",
          limit: { utilization: 2, resetsAt: "2026-07-17T09:19:23.990Z" },
          detail: "118 / 4,000 calls",
        },
      ],
    });
  });
});
