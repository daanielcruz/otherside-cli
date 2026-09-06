import { describe, expect, it } from "bun:test";
import workflowTool from "@/harness/tools/Workflow/tool.json" with { type: "json" };
import { buildWorkflowDescription, workflowSizeGuidelineGuidance } from "../Workflow.ts";

describe("buildWorkflowDescription", () => {
  it("pairs the base wording when orchestration is disabled", () => {
    const description = buildWorkflowDescription("codex", "disabled");

    expect(description).toContain("model?: string, effort?: string");
    expect(description).toContain(
      "opts.model selects a concrete model from the current provider. Default to omitting it — the agent inherits the current route. If the model is unavailable, the call fails instead of selecting another provider.",
    );
    expect(description).toContain("opts.effort overrides the reasoning effort");
    expect(description).toContain("(e.g. 'general-purpose', 'code-reviewer')");
    expect(description).toContain(
      "Before diagnosing why a completed workflow returned an empty or unexpected result",
    );
    expect(description).toContain("othersidecli.com");
    expect(description).not.toContain("tierRank");
    expect(description).not.toContain("opts.tier");
    expect(description).not.toContain("opts.provider");
    expect(description).not.toContain("provider/model");
    expect(description).not.toContain("tier?: 'emperor' | 'shogun' | 'daimyo' | 'samurai'");
  });

  it("pairs CC parameter descriptions with Otherside workflow scopes", () => {
    const properties = workflowTool.inputSchema.properties;

    expect(properties.script.description).toBe(
      "Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().",
    );
    expect(properties.name.description).toBe(
      "Name of a predefined workflow (built-in, user, project, or plugin). Resolves to a self-contained script.",
    );
    expect(properties.args.description).toContain("parameterized named workflows");
    expect(properties.scriptPath.description).toContain(
      "Every Workflow invocation persists its script",
    );
    expect(properties.resumeFromRunId.description).toContain("Stop the prior run first (TaskStop)");
  });

  it("appends configured-size guidance in every orchestration mode", () => {
    for (const [guideline, limit] of [
      ["small", 5],
      ["medium", 15],
      ["large", 50],
    ] as const) {
      for (const mode of ["disabled", "default", "feudalism"] as const) {
        const description = buildWorkflowDescription("codex", mode, guideline);
        expect(description).toContain(
          `A workflow size guideline is configured for this session: ${guideline} — keep workflows under ${limit} agents.`,
        );
        expect(description).toContain("This is a guideline, not a hard limit");
      }
    }
  });

  it("renders the default medium guidance when the guideline is absent or invalid", () => {
    for (const value of [undefined, "invalid"]) {
      const guidance = workflowSizeGuidelineGuidance(value);
      expect(guidance).toContain(
        "This session has the default workflow size guideline: medium — keep workflows under 15 agents.",
      );
      expect(guidance).toContain(
        'The user can raise or remove it with "Dynamic workflow size" in /config.',
      );
    }
  });

  it("adds nothing for an unrestricted guideline", () => {
    expect(workflowSizeGuidelineGuidance("unrestricted")).toBe("");
  });

  it("adds literal provider/model guidance without tier fields in Default mode", () => {
    const description = buildWorkflowDescription("codex", "default");

    expect(description).toContain("provider?: string");
    expect(description).toContain("model?: string");
    expect(description).toContain("Explicit pins are literal");
    expect(description).not.toContain("tier?: 'emperor' | 'shogun' | 'daimyo' | 'samurai'");
    expect(description).not.toContain("diversify?: boolean");
  });

  it("keeps tier doctrine but removes concrete pins in feudalism", () => {
    const description = buildWorkflowDescription("codex", "feudalism");

    expect(description).toContain("tier?: 'emperor' | 'shogun' | 'daimyo' | 'samurai'");
    expect(description).toContain("opts.tier selects a model by multi-provider");
    expect(description).toContain("diversify?: boolean");
    expect(description).not.toContain("To pin a model from another provider");
    expect(description).not.toContain("provider?: string");
    expect(description).not.toContain("model?: string");
    expect(description).toContain("opts.effort overrides the reasoning effort");
    expect(description).toContain("effort?: string");
    expect(description).not.toContain("tierRank");
  });
});
