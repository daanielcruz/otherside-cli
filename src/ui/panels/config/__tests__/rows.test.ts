import { describe, expect, it } from "bun:test";
import { DEFAULT_CONFIG } from "@/kernel/config/config.ts";
import type { BrokerState } from "@/store/app-store/broker.ts";
import {
  configRows,
  cycle,
  cycleOrchestrationMode,
  WORKFLOW_SIZE_GUIDELINE_OPTIONS,
  workflowSizeGuidelineDescription,
} from "../rows.ts";

const state: BrokerState = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  effort: null,
  fastMode: false,
  permissionMode: "default",
};

describe("workflow size guideline config row", () => {
  it("shows every value in the approved order with advisory descriptions", () => {
    expect(WORKFLOW_SIZE_GUIDELINE_OPTIONS).toEqual(["unrestricted", "small", "medium", "large"]);
    expect(WORKFLOW_SIZE_GUIDELINE_OPTIONS.map(workflowSizeGuidelineDescription)).toEqual([
      "No advisory workflow-size target.",
      "Advisory target: keep workflows under 5 agents.",
      "Advisory target: keep workflows under 15 agents.",
      "Advisory target: keep workflows under 50 agents.",
    ]);
    expect(
      configRows(state, DEFAULT_CONFIG, null).find((row) => row.id === "workflowSizeGuideline"),
    ).toMatchObject({
      label: "Workflow size guideline",
      value: "unrestricted",
      kind: "workflowSizeGuideline",
    });
  });

  it("cycles through every value in both directions", () => {
    expect(cycle(WORKFLOW_SIZE_GUIDELINE_OPTIONS, "unrestricted", 1)).toBe("small");
    expect(cycle(WORKFLOW_SIZE_GUIDELINE_OPTIONS, "large", 1)).toBe("unrestricted");
    expect(cycle(WORKFLOW_SIZE_GUIDELINE_OPTIONS, "unrestricted", -1)).toBe("large");
  });
});

describe("orchestration config rows", () => {
  it("renders exact mode values and descriptions", () => {
    const expected = [
      ["disabled", "Agents use models from the current provider only."],
      ["default", "Agents can select any available provider and model."],
      [
        "feudalism",
        "Routes each delegated task through the emperor, shogun, daimyo, or samurai tier roster.",
      ],
    ] as const;
    for (const [value, description] of expected) {
      const mode = value === "feudalism" ? "feudalism" : value;
      const row = configRows(state, { ...DEFAULT_CONFIG, orchestrationMode: mode }, null).find(
        (candidate) => candidate.id === "multiprovider",
      );
      expect(row).toMatchObject({
        label: "Orchestration",
        value,
        description,
      });
    }
  });

  it("cycles in both arrow directions through the canonical values", () => {
    expect(cycleOrchestrationMode("disabled", 1)).toBe("default");
    expect(cycleOrchestrationMode("default", 1)).toBe("feudalism");
    expect(cycleOrchestrationMode("feudalism", 1)).toBe("disabled");
    expect(cycleOrchestrationMode("disabled", -1)).toBe("feudalism");
    expect(cycleOrchestrationMode("feudalism", -1)).toBe("default");
  });

  it("shows quota only in feudalism with exact descriptions", () => {
    for (const mode of ["disabled", "default"] as const) {
      expect(
        configRows(state, { ...DEFAULT_CONFIG, orchestrationMode: mode }, null).some(
          (row) => row.id === "quotaFallback",
        ),
      ).toBe(false);
    }
    const enabled = configRows(
      state,
      { ...DEFAULT_CONFIG, orchestrationMode: "feudalism", quotaFallback: true },
      null,
    ).find((row) => row.id === "quotaFallback");
    expect(enabled?.description).toBe(
      "Uses another provider when the preferred provider hits its quota.",
    );
    const disabled = configRows(
      state,
      { ...DEFAULT_CONFIG, orchestrationMode: "feudalism", quotaFallback: false },
      null,
    ).find((row) => row.id === "quotaFallback");
    expect(disabled?.description).toBe("Stops when the preferred provider hits its quota.");
  });
});

describe("language config rows", () => {
  it("uses the general language row without a separate dictation row", () => {
    const rows = configRows(state, { ...DEFAULT_CONFIG, language: "Japanese" }, null);

    expect(rows.find((row) => row.kind === "language")).toMatchObject({
      label: "Language",
      value: "Japanese",
      kind: "language",
    });
    expect(rows.some((row) => row.id === "dictationLanguage")).toBe(false);
    expect(rows.some((row) => row.label === "Dictation language")).toBe(false);
  });
});

describe("media provider config rows", () => {
  it("shows off for a provider without native image generation", () => {
    const rows = configRows(state, DEFAULT_CONFIG, null);
    expect(rows.find((row) => row.id === "imageGenProvider")).toMatchObject({
      label: "Image generator",
      value: "Off",
      kind: "imageGeneratorProvider",
    });
    expect(rows.find((row) => row.id === "voiceProvider")).toMatchObject({
      label: "Voice provider",
      value: "Anthropic · native default · not configured",
      kind: "voiceProvider",
    });
  });

  it("shows native defaults and labels explicit providers", () => {
    const xaiRows = configRows(
      { ...state, provider: "xai", model: "grok-4.5" },
      DEFAULT_CONFIG,
      null,
    );
    expect(xaiRows.find((row) => row.id === "imageGenProvider")).toMatchObject({
      label: "Image generator",
      value: "Grok · native default · not configured",
      kind: "imageGeneratorProvider",
    });
    expect(xaiRows.find((row) => row.id === "voiceProvider")).toMatchObject({
      label: "Voice provider",
      value: "Grok · native default · not configured",
      kind: "voiceProvider",
    });

    const geminiRows = configRows(
      state,
      { ...DEFAULT_CONFIG, imageGenProvider: "antigravity" },
      null,
    );
    expect(geminiRows.find((row) => row.id === "imageGenProvider")?.value).toBe(
      "Gemini · not configured",
    );

    const nonNativeRows = configRows(
      { ...state, provider: "deepseek", model: "deepseek-chat" },
      { ...DEFAULT_CONFIG, voiceProvider: "anthropic" },
      null,
    );
    expect(nonNativeRows.find((row) => row.id === "voiceProvider")?.value).toBe(
      "Anthropic · not configured",
    );
  });
});
