import { describe, expect, it } from "bun:test";
import type { LayerContext } from "@/harness/composer/injections.ts";
import { makeQueue } from "@/harness/composer/queue.ts";
import { operatorCoreLayer } from "@/harness/core/operator-core/operator-core.ts";
import { outputStyleLayer } from "@/harness/core/output-style.ts";
import {
  BUILT_IN_OUTPUT_STYLES,
  type OutputStyleRecord,
  outputStyleTurnReminder,
} from "@/harness/routines/output-styles/built-in.ts";
import { DEFAULT_CONFIG } from "@/kernel/config/config.ts";

const INTRO_DEFAULT = "helps users with software engineering tasks.";
const INTRO_STYLED = 'helps users according to your "Output Style" below';

function contextWith(outputStyle: OutputStyleRecord | null): LayerContext {
  return {
    provider: "anthropic",
    model: "claude-opus-4-8",
    effort: null,
    permissionMode: "default",
    sessionId: "sess-fixture",
    cwd: "/tmp/fixture",
    config: DEFAULT_CONFIG,
    outputStyle,
    orchestrationMode: "disabled",
    mcpInstructionBlocks: [],
    injections: makeQueue(),
    deferredToolExclusions: new Set<string>(),
    emitDeferredReminder: true,
    emitAgentListing: true,
    promoteMidSystem: true,
    supportsMidSystem: true,
    lean: false,
    modelFamily: "other" as const,
    availableModels: [],
    knowledgeCutoff: null,
    agentRows: [],
    deferredToolNames: [],
    deferredMcpToolNames: [],
    memorySection: null,
    projectMemorySection: null,
    skillListing: [],
  } as unknown as LayerContext;
}

function custom(overrides: Partial<OutputStyleRecord> = {}): OutputStyleRecord {
  return {
    name: "Terse",
    description: "Short answers",
    prompt: "Answer in one sentence.",
    source: "user",
    ...overrides,
  };
}

describe("output-style layer", () => {
  it("renders nothing when no style is active", () => {
    expect(outputStyleLayer.render(contextWith(null))).toBeNull();
  });

  it("heads the section with the style name and carries its prompt verbatim", () => {
    const proactive = BUILT_IN_OUTPUT_STYLES.Proactive as OutputStyleRecord;
    const body = outputStyleLayer.render(contextWith(proactive));
    expect(body).toBe(`# Output Style: Proactive\n${proactive.prompt}`);
  });
});

describe("operator core under a style", () => {
  it("keeps the stock intro and coding guidance with no style active", () => {
    const core = operatorCoreLayer.render(contextWith(null)) ?? "";
    expect(core).toContain(INTRO_DEFAULT);
    expect(core).not.toContain(INTRO_STYLED);
    expect(core).toContain("# Doing tasks");
  });

  it("defers the intro to the style and keeps coding guidance when the style asks", () => {
    const core = operatorCoreLayer.render(contextWith(custom({ keepCodingInstructions: true })));
    expect(core).toContain(INTRO_STYLED);
    expect(core).not.toContain(INTRO_DEFAULT);
    expect(core).toContain("# Doing tasks");
  });

  it("drops the coding guidance when the style does not keep it", () => {
    const core = operatorCoreLayer.render(contextWith(custom())) ?? "";
    expect(core).toContain(INTRO_STYLED);
    expect(core).not.toContain("# Doing tasks");
    // The section that followed it survives the removal.
    expect(core).toContain("# Executing actions with care");
  });
});

describe("outputStyleTurnReminder", () => {
  it("stays silent for the default style and unknown names", () => {
    expect(outputStyleTurnReminder("default")).toBeNull();
    expect(outputStyleTurnReminder(undefined)).toBeNull();
    expect(outputStyleTurnReminder("Nonexistent")).toBeNull();
  });

  it("uses the style's own reminder when it has one", () => {
    expect(outputStyleTurnReminder("Proactive")).toBe(
      "Proactive output style is active. Execute autonomously, minimize interruptions, prefer action over planning.",
    );
  });

  it("falls back to the generic guideline sentence", () => {
    expect(outputStyleTurnReminder("Explanatory")).toBe(
      "Explanatory output style is active. Remember to follow the specific guidelines for this style.",
    );
  });
});
