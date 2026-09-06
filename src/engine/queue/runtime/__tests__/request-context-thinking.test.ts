import { afterEach, describe, expect, it } from "bun:test";
import { detachSessionWorktreeHost } from "@/engine/session/worktree-runtime.ts";
import { makeRequestContext } from "../request-context.ts";
import type { AgentDeps } from "../turn/types.ts";

const SESSION_ID = "sess-request-context-thinking";

function makeDeps(config: Record<string, unknown>): AgentDeps {
  const session = { id: SESSION_ID, cwd: "/tmp/otherside-ctx-test" };
  const broker = {
    read: () => ({
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: null,
      fastMode: false,
      permissionMode: "default",
      orchestrationMode: "disabled",
    }),
  };
  return { session, broker, config } as unknown as AgentDeps;
}

describe("makeRequestContext thinking-summary derivation", () => {
  afterEach(() => {
    detachSessionWorktreeHost(SESSION_ID);
  });

  it("summaries off suppresses thinking for every provider through the shared field", () => {
    const ctx = makeRequestContext(makeDeps({ showThinkingSummaries: false }));
    expect(ctx.showThinkingSummaries).toBe(false);
    expect(ctx.suppressThinkingSummary).toBe(true);
  });

  it("summaries on leaves the suppression field unset", () => {
    const ctx = makeRequestContext(makeDeps({ showThinkingSummaries: true }));
    expect(ctx.showThinkingSummaries).toBe(true);
    expect(ctx.suppressThinkingSummary).toBeUndefined();
  });

  it("an absent setting defaults to visible summaries", () => {
    const ctx = makeRequestContext(makeDeps({}));
    expect(ctx.showThinkingSummaries).toBe(true);
    expect(ctx.suppressThinkingSummary).toBeUndefined();
  });
});
