import { describe, expect, it } from "bun:test";
import { DEFAULT_CONFIG } from "@/kernel/config/config.ts";
import type { BrokerState } from "@/store/app-store/broker.ts";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.ts";
import { toggledBoolConfig } from "../row-actions.ts";
import {
  configRows,
  cycle,
  cycleOrchestrationMode,
  editorModeDescription,
  WORKFLOW_SIZE_CLASS_OPTIONS,
  workflowSizeGuidelineDescription,
} from "../rows.ts";
import { createConfigPanel } from "../string-view.ts";

const state: BrokerState = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  effort: null,
  fastMode: false,
  permissionMode: "default",
  orchestrationMode: "disabled",
};

describe("workflow size guideline config row", () => {
  it("shows every value in the approved order with advisory descriptions", () => {
    expect(WORKFLOW_SIZE_CLASS_OPTIONS).toEqual(["unrestricted", "small", "medium", "large"]);
    expect(WORKFLOW_SIZE_CLASS_OPTIONS.map(workflowSizeGuidelineDescription)).toEqual([
      "No advisory workflow-size target.",
      "Advisory target: keep workflows under 5 agents.",
      "Advisory target: keep workflows under 15 agents.",
      "Advisory target: keep workflows under 50 agents.",
    ]);
    expect(workflowSizeGuidelineDescription(undefined)).toBe(
      "Default advisory target: keep workflows under 15 agents.",
    );
    expect(
      configRows(state, DEFAULT_CONFIG, null).find((row) => row.id === "workflowSizeGuideline"),
    ).toMatchObject({
      label: "Dynamic workflow size",
      value: "default (medium)",
      kind: "workflowSizeGuideline",
    });
  });

  it("cycles through every value in both directions", () => {
    expect(cycle(WORKFLOW_SIZE_CLASS_OPTIONS, "unrestricted", 1)).toBe("small");
    expect(cycle(WORKFLOW_SIZE_CLASS_OPTIONS, "large", 1)).toBe("unrestricted");
    expect(cycle(WORKFLOW_SIZE_CLASS_OPTIONS, "unrestricted", -1)).toBe("large");
  });
});

describe("orchestration config rows", () => {
  it("renders exact mode values and descriptions", () => {
    const expected = [
      [
        "disabled",
        "Agents use models from the current provider only. Full setup in /orchestration.",
      ],
      [
        "default",
        "Agents can select any available provider and model. Full setup in /orchestration.",
      ],
      [
        "feudalism",
        "Routes each delegated task through the emperor, shogun, daimyo, or samurai tier roster. Full setup in /orchestration.",
      ],
    ] as const;
    for (const [value, description] of expected) {
      const mode = value === "feudalism" ? "feudalism" : value;
      const row = configRows({ ...state, orchestrationMode: mode }, DEFAULT_CONFIG, null).find(
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
        configRows({ ...state, orchestrationMode: mode }, DEFAULT_CONFIG, null).some(
          (row) => row.id === "quotaFallback",
        ),
      ).toBe(false);
    }
    const feudalState = { ...state, orchestrationMode: "feudalism" as const };
    const enabled = configRows(feudalState, { ...DEFAULT_CONFIG, quotaFallback: true }, null).find(
      (row) => row.id === "quotaFallback",
    );
    expect(enabled?.description).toBe(
      "Uses another provider when the preferred provider hits its quota.",
    );
    const disabled = configRows(
      feudalState,
      { ...DEFAULT_CONFIG, quotaFallback: false },
      null,
    ).find((row) => row.id === "quotaFallback");
    expect(disabled?.description).toBe("Stops when the preferred provider hits its quota.");
  });
});

describe("multi-model fork config row", () => {
  it("defaults to disabled with the inherit hint, in every orchestration mode", () => {
    for (const mode of ["disabled", "default", "feudalism"] as const) {
      const row = configRows({ ...state, orchestrationMode: mode }, DEFAULT_CONFIG, null).find(
        (candidate) => candidate.id === "multiModelFork",
      );
      expect(row).toMatchObject({
        label: "Multi-model fork",
        value: "disabled",
        kind: "bool",
        description: "Agents always inherit this session's provider and model.",
      });
    }
  });

  it("names the approval cost once enabled", () => {
    const row = configRows(state, { ...DEFAULT_CONFIG, multiModelFork: true }, null).find(
      (candidate) => candidate.id === "multiModelFork",
    );
    expect(row).toMatchObject({
      value: "enabled",
      description: "Agents may run on another provider/model after you approve the extra cost.",
    });
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

describe("config panel list window", () => {
  it("moves the visible settings window with the selected row", () => {
    const panel = createConfigPanel(() => {});
    const down = {
      kind: "key" as const,
      fn: false,
      name: "down",
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      super: false,
      sequence: undefined,
      raw: undefined,
      isPasted: false,
    };

    const initial = panel.render(80).map(stripAnsi);
    expect(initial.some((line) => line.includes("more below"))).toBe(true);

    for (let index = 0; index < 5; index++) panel.handleKey(down);
    const afterMoving = panel.render(80).map(stripAnsi);
    expect(afterMoving.some((line) => line.includes("more above"))).toBe(true);
    expect(afterMoving.some((line) => line.includes("more below"))).toBe(true);
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

describe("transcript view config rows", () => {
  it("offers thinking summaries, verbose output, and startup view mode with defaults", () => {
    const rows = configRows(state, DEFAULT_CONFIG, null);
    expect(rows.find((row) => row.id === "showThinkingSummaries")).toMatchObject({
      label: "Thinking summaries",
      value: "true",
      kind: "bool",
    });
    expect(rows.find((row) => row.id === "verbose")).toMatchObject({
      label: "Verbose output",
      value: "false",
      kind: "bool",
    });
  });

  it("reflects persisted values", () => {
    const rows = configRows(
      state,
      { ...DEFAULT_CONFIG, showThinkingSummaries: false, verbose: true },
      null,
    );
    expect(rows.find((row) => row.id === "showThinkingSummaries")?.value).toBe("false");
    expect(rows.find((row) => row.id === "verbose")?.value).toBe("true");
  });
});

describe("editor mode config row", () => {
  it("offers the setting with the shipped default in force", () => {
    expect(
      configRows(state, DEFAULT_CONFIG, null).find((row) => row.id === "editorMode"),
    ).toMatchObject({
      label: "Editor mode",
      value: "normal",
      kind: "bool",
    });
  });

  it("names the mode in force once it is chosen", () => {
    const rows = configRows(state, { ...DEFAULT_CONFIG, editorMode: "vim" }, null);

    expect(rows.find((row) => row.id === "editorMode")?.value).toBe("vim");
  });

  // The prompt resolves the mode once when it is built, so a row that promised an
  // immediate change would be lying about what the reader just did.
  it("says when a change starts applying", () => {
    expect(editorModeDescription("vim")).toContain("Takes effect from the next session.");
    expect(editorModeDescription("normal")).toContain("Takes effect from the next session.");
    expect(editorModeDescription("vim")).toContain("Modal editing");
  });

  it("flips between the two modes and back", () => {
    const toVim = toggledBoolConfig(DEFAULT_CONFIG, "editorMode", state, 0);
    expect(toVim?.cfg.editorMode).toBe("vim");

    const backToNormal = toggledBoolConfig(toVim?.cfg ?? DEFAULT_CONFIG, "editorMode", state, 0);
    expect(backToNormal?.cfg.editorMode).toBe("normal");
  });
});
