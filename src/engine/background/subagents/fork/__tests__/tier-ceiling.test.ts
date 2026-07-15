import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type AgentContext, runWithAgentContext } from "@/engine/agents/agent-context.ts";
import { resolveWorkflowAgentModelContextDetailed } from "@/engine/background/workflows/runtime/subagent/bridge.ts";
import { setCredentialsLoaderForTests } from "@/engine/model/tier/resolver.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import type { CredentialsBundle } from "@/kernel/storage/credentials.ts";
import { resolveSubagentRoutingForDispatch } from "../routing.ts";

registerAllProviders();

const TEST_DEF: Parameters<typeof resolveSubagentRoutingForDispatch>[1] = {
  id: "tier-ceiling-test-agent",
  name: "Tier Ceiling Test Agent",
  description: "Test definition",
  body: "Test body",
  tools: null,
  disallowedTools: null,
  model: {},
  background: false,
  scope: "builtin",
};

const BASE_INVOCATION: Parameters<typeof resolveSubagentRoutingForDispatch>[2] = {
  subagentType: "tier-ceiling-test-agent",
  prompt: "Test prompt",
};

function warriorContext(): RequestContext {
  return {
    provider: "codex",
    model: "gpt-5.6-terra",
    effort: null,
    permissionMode: "default",
    multiproviderEnabled: true,
  } as RequestContext;
}

function nestedContext(): AgentContext {
  return {
    agentId: "tier-ceiling-parent",
    depth: 1,
    parentSessionId: "tier-ceiling-session",
    agentType: "subagent",
    subagentName: "tier-ceiling-parent",
    sessionAllowedToolPatterns: new Set<string>(),
  };
}

function resolveNested(invocation: Parameters<typeof resolveSubagentRoutingForDispatch>[2]) {
  return runWithAgentContext(nestedContext(), () =>
    resolveSubagentRoutingForDispatch(warriorContext(), TEST_DEF, invocation),
  );
}

beforeEach(() => {
  setCredentialsLoaderForTests(
    () => ({ codex: { accessToken: "x" } }) as unknown as CredentialsBundle,
  );
});

afterEach(() => {
  setCredentialsLoaderForTests(null);
});

describe("nested tier ceiling", () => {
  it("clamps a nested warrior request for general and reports the downgrade", async () => {
    const result = await resolveNested({ ...BASE_INVOCATION, tierOverride: "general" });

    expect(result).toMatchObject({
      ok: true,
      ctx: { provider: "codex", model: "gpt-5.6-terra" },
      routingNotice: "tier clamped to warrior: nested agents cannot launch above their own tier.",
    });
  });

  it("leaves nested same-tier and lower-tier requests unchanged", async () => {
    const sameTier = await resolveNested({ ...BASE_INVOCATION, tierOverride: "warrior" });
    const lowerTier = await resolveNested({ ...BASE_INVOCATION, tierOverride: "scout" });

    expect(sameTier).toMatchObject({
      ok: true,
      ctx: { provider: "codex", model: "gpt-5.6-terra" },
    });
    expect(lowerTier).toMatchObject({
      ok: true,
      ctx: { provider: "codex", model: "gpt-5.6-luna" },
    });
    if (sameTier.ok) expect(sameTier.routingNotice).toBeUndefined();
    if (lowerTier.ok) expect(lowerTier.routingNotice).toBeUndefined();
  });

  it("clamps a pinned model above the nested ceiling to tier routing", async () => {
    const result = await resolveNested({
      ...BASE_INVOCATION,
      providerOverride: "codex",
      modelOverride: "gpt-5.6-sol",
    });

    expect(result).toMatchObject({
      ok: true,
      ctx: { provider: "codex", model: "gpt-5.6-terra" },
      routingNotice: "tier clamped to warrior: nested agents cannot launch above their own tier.",
    });
  });

  it("allows an unranked pinned model unchanged", async () => {
    const result = await resolveNested({
      ...BASE_INVOCATION,
      providerOverride: "codex",
      modelOverride: "gpt-5.5",
    });

    expect(result).toMatchObject({
      ok: true,
      ctx: { provider: "codex", model: "gpt-5.5" },
    });
    if (result.ok) expect(result.routingNotice).toBeUndefined();
  });

  it("leaves main-session requests unrestricted", async () => {
    const result = await resolveSubagentRoutingForDispatch(warriorContext(), TEST_DEF, {
      ...BASE_INVOCATION,
      tierOverride: "general",
    });

    expect(result).toMatchObject({
      ok: true,
      ctx: { provider: "codex", model: "gpt-5.6-sol" },
    });
    if (result.ok) expect(result.routingNotice).toBeUndefined();
  });

  it("clamps workflow tier routing in a nested context", () => {
    const result = runWithAgentContext(nestedContext(), () =>
      resolveWorkflowAgentModelContextDetailed(warriorContext(), { tier: "general" }),
    );

    expect(result).toMatchObject({
      ok: true,
      ctx: { provider: "codex", model: "gpt-5.6-terra" },
      degradedReasons: [
        "tier clamped to warrior: nested agents cannot launch above their own tier.",
      ],
    });
  });
});
