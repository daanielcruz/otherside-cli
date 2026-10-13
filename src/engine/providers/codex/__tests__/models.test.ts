import { describe, expect, it } from "bun:test";
import { MODELS } from "../models.ts";

describe("Codex static model catalog", () => {
  it("matches the manually captured offline catalog", () => {
    expect(MODELS).toEqual([
      {
        id: "gpt-6-astra",
        displayName: "GPT-6 Astra",
        contextWindow: 872_000,
        autoCompactTokenLimit: 784_800,
        provider: "codex",
        supportsPdf: true,
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "high",
        augment: {
          useResponsesLite: true,
          serviceTiers: ["priority"],
          defaultVerbosity: "low",
        },
      },
      {
        id: "gpt-6.1-sol",
        displayName: "GPT-6.1 Sol",
        contextWindow: 872_000,
        autoCompactTokenLimit: 784_800,
        provider: "codex",
        supportsPdf: true,
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "high",
        augment: {
          useResponsesLite: true,
          serviceTiers: ["priority"],
          defaultVerbosity: "low",
        },
      },
      {
        id: "gpt-daybreak-blue-latest",
        displayName: "GPT Daybreak Blue",
        contextWindow: 372_000,
        autoCompactTokenLimit: 334_800,
        provider: "codex",
        supportsPdf: true,
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "high",
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
        supportsPdf: true,
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "high",
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
        supportsPdf: true,
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "high",
        augment: {
          useResponsesLite: true,
          serviceTiers: ["priority"],
          defaultVerbosity: "low",
        },
      },
    ]);
  });

  it("keeps the owner-chosen 5.6 window rather than either wire field", () => {
    for (const id of ["gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(MODELS.find((model) => model.id === id)).toMatchObject({
        contextWindow: 372_000,
        autoCompactTokenLimit: 334_800,
      });
    }
  });

  it("carries no model the Codex roster has retired or dropped", () => {
    const ids = MODELS.map((model) => model.id);
    for (const gone of [
      "gpt-5.6-sol",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]) {
      expect(ids).not.toContain(gone);
    }
  });
});
