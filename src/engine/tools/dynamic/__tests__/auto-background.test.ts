import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildAgentInputSchema } from "@/engine/tools/dynamic/Agent.ts";
import { buildAgentDescription } from "@/harness/tools/Agent/description.ts";
import { isAgentAutoBackgroundEnabled } from "@/kernel/config/agent-auto-background.ts";

const FOREGROUND_PARAM_TEXT =
  "Set to true to run this agent in the background. You will be automatically notified when it completes — do not poll or sleep waiting on it. Defaults to false (foreground): the tool returns the agent's result inline so you can use it immediately.";

const ENV_KEYS = ["OTHERSIDE_DISABLE_AGENT_AUTO_BACKGROUND"] as const;

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("isAgentAutoBackgroundEnabled", () => {
  test("defaults to enabled", () => {
    expect(isAgentAutoBackgroundEnabled()).toBe(true);
  });

  test("OTHERSIDE_DISABLE_AGENT_AUTO_BACKGROUND=1 disables", () => {
    process.env.OTHERSIDE_DISABLE_AGENT_AUTO_BACKGROUND = "1";
    expect(isAgentAutoBackgroundEnabled()).toBe(false);
  });
});

describe("Agent description background default", () => {
  test("swaps the section to background semantics when env is unset", () => {
    const description = buildAgentDescription();
    expect(description).toContain("## Background execution");
    expect(description).toContain("always run in the **background**");
    expect(description).toContain("only a receipt");
    expect(description).not.toContain("## Foreground vs background");
    expect(description).not.toContain("By default an agent runs in the **foreground**");
  });

  test("full-tier usage bullet is swapped too", () => {
    const description = buildAgentDescription({ lean: false });
    expect(description).toContain("- **Background execution**:");
    expect(description).not.toContain("Use foreground (default)");
  });

  test("keeps foreground text when auto-background is disabled", () => {
    process.env.OTHERSIDE_DISABLE_AGENT_AUTO_BACKGROUND = "1";
    const description = buildAgentDescription();
    expect(description).toContain("## Foreground vs background");
    expect(description).toContain("By default an agent runs in the **foreground**");
    expect(description).not.toContain("## Background execution");
  });

  test("disabled path is byte-identical for the full-tier bullet", () => {
    process.env.OTHERSIDE_DISABLE_AGENT_AUTO_BACKGROUND = "1";
    const description = buildAgentDescription({ lean: false });
    expect(description).toContain("Use foreground (default)");
    expect(description).not.toContain("- **Background execution**:");
  });

  test("subagent filtering preserves the generic foreground section", () => {
    process.env.OTHERSIDE_DISABLE_AGENT_AUTO_BACKGROUND = "1";
    const description = buildAgentDescription({ mainAgent: false });
    expect(description).toContain("## Foreground vs background");
    expect(description).toContain("## Writing the prompt");
    expect(description).not.toContain("## When to fork");
    expect(description).not.toContain("Don't peek");
    expect(description).not.toContain("Don't race");
    expect(description).not.toContain("Writing a fork prompt");
  });
});

describe("run_in_background wire schema", () => {
  test("omits the field while auto-background is enabled", () => {
    const schema = buildAgentInputSchema();
    const properties = schema.properties as Record<string, unknown>;
    expect(properties.run_in_background).toBeUndefined();
  });

  test("restores the normal field when auto-background is disabled", () => {
    process.env.OTHERSIDE_DISABLE_AGENT_AUTO_BACKGROUND = "1";
    const schema = buildAgentInputSchema();
    const properties = schema.properties as Record<string, { description?: string }>;
    expect(properties.run_in_background?.description).toBe(FOREGROUND_PARAM_TEXT);
  });
});
