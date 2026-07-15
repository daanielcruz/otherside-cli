import { describe, expect, it } from "bun:test";
import { MODELS } from "../models.ts";

describe("Codex static model catalog", () => {
  it("matches the manually captured offline catalog", () => {
    expect(MODELS).toEqual([
      {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        contextWindow: 372_000,
        autoCompactTokenLimit: 334_800,
        provider: "codex",
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "medium",
        augment: {
          useResponsesLite: true,
          serviceTiers: ["priority"],
          defaultVerbosity: "low",
        },
      },
      {
        id: "gpt-5.6-terra",
        displayName: "GPT-5.6 Terra",
        contextWindow: 372_000,
        autoCompactTokenLimit: 334_800,
        provider: "codex",
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "medium",
        augment: {
          useResponsesLite: true,
          serviceTiers: ["priority"],
          defaultVerbosity: "low",
        },
      },
      {
        id: "gpt-5.6-luna",
        displayName: "GPT-5.6 Luna",
        contextWindow: 372_000,
        autoCompactTokenLimit: 334_800,
        provider: "codex",
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "medium",
        augment: {
          useResponsesLite: true,
          serviceTiers: ["priority"],
          defaultVerbosity: "low",
        },
      },
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        contextWindow: 300_000,
        autoCompactTokenLimit: 280_000,
        provider: "codex",
        onDemand: true,
        efforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "medium",
        augment: {
          useResponsesLite: false,
          serviceTiers: ["priority"],
          defaultVerbosity: "low",
        },
      },
      {
        id: "gpt-5.4",
        displayName: "GPT-5.4",
        contextWindow: 272_000,
        autoCompactTokenLimit: 244_800,
        provider: "codex",
        onDemand: true,
        efforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "medium",
        augment: {
          useResponsesLite: false,
          serviceTiers: ["priority"],
          defaultVerbosity: "low",
        },
      },
      {
        id: "gpt-5.4-mini",
        displayName: "GPT-5.4 Mini",
        contextWindow: 272_000,
        autoCompactTokenLimit: 244_800,
        provider: "codex",
        onDemand: true,
        efforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "medium",
        augment: {
          useResponsesLite: false,
          serviceTiers: [],
          defaultVerbosity: "medium",
        },
      },
      {
        id: "gpt-5.3-codex-spark",
        displayName: "GPT-5.3 Codex Spark",
        contextWindow: 128_000,
        autoCompactTokenLimit: 108_000,
        provider: "codex",
        onDemand: true,
        efforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "high",
        augment: {
          useResponsesLite: false,
          serviceTiers: [],
          defaultVerbosity: "low",
        },
      },
    ]);
  });

  it("keeps the gpt-5.5 owner window override", () => {
    expect(MODELS.find((model) => model.id === "gpt-5.5")).toMatchObject({
      contextWindow: 300_000,
      autoCompactTokenLimit: 280_000,
    });
  });

  it("keeps Spark visible without service tiers", () => {
    const spark = MODELS.find((model) => model.id === "gpt-5.3-codex-spark");

    expect(spark).toBeDefined();
    expect(spark?.augment?.serviceTiers).toEqual([]);
  });
});
