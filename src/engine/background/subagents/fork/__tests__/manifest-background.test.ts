import { describe, expect, it } from "bun:test";
import { shouldAvoidPermissionPromptsForSubagent, subagentLaunchDetaches } from "../spawn.ts";

// The manifest field exists for the env-gated case: with the auto-background
// default switched off, `background: true` still detaches the launch.
describe("subagentLaunchDetaches", () => {
  const invocation = (runInBackground?: boolean) => ({
    subagentType: "t",
    prompt: "p",
    ...(runInBackground !== undefined ? { runInBackground } : {}),
  });

  it("detaches when the invocation asks for background", () => {
    expect(subagentLaunchDetaches(invocation(true), { background: false })).toBe(true);
  });

  it("detaches when the definition sets background: true, even without the flag", () => {
    expect(subagentLaunchDetaches(invocation(false), { background: true })).toBe(true);
    expect(subagentLaunchDetaches(invocation(), { background: true })).toBe(true);
  });

  it("stays synchronous when neither the flag nor the definition opts in", () => {
    expect(subagentLaunchDetaches(invocation(false), { background: false })).toBe(false);
    expect(subagentLaunchDetaches(invocation(), { background: false })).toBe(false);
  });
});

describe("named subagent permission prompts", () => {
  const invocation = (runInBackground?: boolean) => ({
    subagentType: "t",
    prompt: "write outside the workspace",
    ...(runInBackground !== undefined ? { runInBackground } : {}),
  });

  it("keeps a foreground named subagent prompt-capable", () => {
    expect(shouldAvoidPermissionPromptsForSubagent(invocation(false), { background: false })).toBe(
      false,
    );
  });

  it("continues auto-denying asks for detached named subagents", () => {
    expect(shouldAvoidPermissionPromptsForSubagent(invocation(true), { background: false })).toBe(
      true,
    );
    expect(shouldAvoidPermissionPromptsForSubagent(invocation(false), { background: true })).toBe(
      true,
    );
  });
});
