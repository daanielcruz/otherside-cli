import { describe, expect, it } from "bun:test";
import { DEFAULT_CONFIG } from "@/kernel/config/config.ts";
import type { BrokerState } from "@/store/app-store/broker.ts";
import { configRows } from "./rows.ts";

const state: BrokerState = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  effort: null,
  fastMode: false,
  permissionMode: "default",
};

describe("orchestration config rows", () => {
  it("defaults to disabled and hides quota fallback", () => {
    const rows = configRows(state, DEFAULT_CONFIG, null);
    expect(rows.find((row) => row.id === "multiprovider")).toMatchObject({
      label: "Orchestration",
      value: "disabled",
    });
    expect(rows.some((row) => row.id === "quotaFallback")).toBe(false);
  });

  it("shows experimental tiering and quota fallback only while enabled", () => {
    const rows = configRows(
      state,
      { ...DEFAULT_CONFIG, tierSelectorEnabled: true, orchestratorMode: "soft" },
      null,
    );
    expect(rows.find((row) => row.id === "multiprovider")?.value).toBe("experimental tiering");
    expect(rows.find((row) => row.id === "quotaFallback")?.label).toBe("Quota fallback");
  });
});
