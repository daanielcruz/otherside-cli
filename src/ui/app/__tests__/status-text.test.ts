import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { registerRuntimeModel, resetRuntimeModelsForTests } from "@/engine/model/catalog.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import { compactDoneText, computeAutoCompactRemainingPct } from "@/ui/app/status-text.ts";

describe("computeAutoCompactRemainingPct", () => {
  const ENV_KEY = "OTHERSIDE_AUTO_COMPACT_WINDOW";
  const originalEnv = process.env[ENV_KEY];

  beforeAll(() => registerAllProviders());

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
    resetRuntimeModelsForTests();
  });

  it("shows 0% only at the model compact threshold", () => {
    expect(computeAutoCompactRemainingPct(107_999, "gpt-5.3-codex-spark", "codex")).toBe(1);
    expect(computeAutoCompactRemainingPct(108_000, "gpt-5.3-codex-spark", "codex")).toBe(0);
    expect(computeAutoCompactRemainingPct(108_001, "gpt-5.3-codex-spark", "codex")).toBe(0);
  });

  it("uses provider-scoped compact limits when model ids collide", () => {
    const model = "shared-compact-boundary";
    registerRuntimeModel({
      id: model,
      displayName: "Codex boundary",
      contextWindow: 200_000,
      autoCompactTokenLimit: 180_000,
      provider: "codex",
      efforts: ["high"],
      defaultEffort: "high",
    });
    registerRuntimeModel({
      id: model,
      displayName: "xAI boundary",
      contextWindow: 200_000,
      autoCompactTokenLimit: 120_000,
      provider: "xai",
      efforts: ["high"],
      defaultEffort: "high",
    });

    expect(computeAutoCompactRemainingPct(119_999, model, "xai")).toBe(1);
    expect(computeAutoCompactRemainingPct(120_000, model, "xai")).toBe(0);
    expect(computeAutoCompactRemainingPct(179_999, model, "codex")).toBe(1);
    expect(computeAutoCompactRemainingPct(180_000, model, "codex")).toBe(0);
  });

  it("reflects an OTHERSIDE_AUTO_COMPACT_WINDOW shrink in the threshold used for the percent", () => {
    const model = "window-shrink-status-model";
    registerRuntimeModel({
      id: model,
      displayName: model,
      contextWindow: 1_000_000,
      provider: "xai",
      efforts: ["high"],
      defaultEffort: "high",
    });
    process.env[ENV_KEY] = "200000";
    expect(computeAutoCompactRemainingPct(166_999, model, "xai")).toBe(1);
    expect(computeAutoCompactRemainingPct(167_000, model, "xai")).toBe(0);
    expect(computeAutoCompactRemainingPct(167_000, model, "xai")).not.toBe(
      Math.max(0, Math.round((1 - 167_000 / 967_000) * 100)),
    );
  });

  it("hits 0% at 967_000 for a 1M-window model", () => {
    const model = "million-window-status-model";
    registerRuntimeModel({
      id: model,
      displayName: model,
      contextWindow: 1_000_000,
      provider: "xai",
      efforts: ["high"],
      defaultEffort: "high",
    });
    expect(computeAutoCompactRemainingPct(967_000, model, "xai")).toBe(0);
    expect(computeAutoCompactRemainingPct(960_000, model, "xai")).toBeGreaterThan(0);
  });
});

describe("compactDoneText", () => {
  it("renders the canceled text when cancelled is true, regardless of message", () => {
    const text = compactDoneText({
      mode: "failed",
      durationMs: 2000,
      truncatedMessages: 0,
      error: "upstream request aborted",
      cancelled: true,
    });
    expect(text).toBe("Compaction canceled (2s)");
  });

  it("renders the failed text when cancelled is false, even if the message mentions abort/cancel", () => {
    const text = compactDoneText({
      mode: "failed",
      durationMs: 3000,
      truncatedMessages: 0,
      error: "request aborted by upstream",
      cancelled: false,
    });
    expect(text).toBe("Conversation compact failed (3s) — request aborted by upstream");
  });

  it("falls back to the legacy message regex when cancelled is undefined", () => {
    const canceled = compactDoneText({
      mode: "failed",
      durationMs: 1000,
      truncatedMessages: 0,
      error: "user-cancelled",
    });
    expect(canceled).toBe("Compaction canceled (1s)");

    const failed = compactDoneText({
      mode: "failed",
      durationMs: 1000,
      truncatedMessages: 0,
      error: "provider returned a 500",
    });
    expect(failed).toBe("Conversation compact failed (1s) — provider returned a 500");
  });
});
