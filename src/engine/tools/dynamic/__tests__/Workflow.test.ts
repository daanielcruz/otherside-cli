import { describe, expect, it } from "bun:test";
import workflowTool from "@/harness/tools/Workflow/tool.json" with { type: "json" };
import { buildWorkflowDescription } from "../Workflow.ts";

describe("buildWorkflowDescription", () => {
  it("pairs the CC base wording when multiprovider is disabled", () => {
    const description = buildWorkflowDescription("codex", false);

    expect(description).toContain("model?: string, effort?: string");
    expect(description).toContain("opts.effort overrides the reasoning effort");
    expect(description).toContain("(e.g. 'general-purpose', 'code-reviewer')");
    expect(description).toContain(
      "Before diagnosing why a completed workflow returned an empty or unexpected result",
    );
    expect(description).toContain("othersidecli.com");
    expect(description).not.toContain("tierRank");
    expect(description).not.toContain("opts.tier selects");
    expect(description).not.toContain("tier?: 'general' | 'warrior' | 'scout'");
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

  it("keeps the CC base and adds multiprovider routing when enabled", () => {
    const description = buildWorkflowDescription("codex", true);

    expect(description).toContain("tier?: 'general' | 'warrior' | 'scout'");
    expect(description).toContain("opts.tier selects a model by multi-provider");
    expect(description).toContain("To pin a model from another provider");
    expect(description).toContain("opts.provider");
    expect(description).toContain("opts.effort overrides the reasoning effort");
    expect(description).toContain("effort?: string");
    expect(description).toContain("(e.g. 'general-purpose', 'code-reviewer')");
    expect(description).toContain(
      "Before diagnosing why a completed workflow returned an empty or unexpected result",
    );
    expect(description).not.toContain("tierRank");
  });
});
