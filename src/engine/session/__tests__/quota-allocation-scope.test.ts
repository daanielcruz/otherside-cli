import { describe, expect, it } from "bun:test";
import {
  enrollWorkflowTask,
  listActiveWorkflowAgentAllocations,
  resetWorkflowTasksForTests,
  updateWorkflowTask,
} from "@/engine/background/workflows/runtime/store/store.ts";
import type { WorkflowTaskLifecycle } from "@/engine/background/workflows/runtime/store/types.ts";
import { applyCodexQuotaWarning } from "@/engine/providers/codex/usage.ts";
import {
  clearRoutingUsage,
  clearUsageLimits,
  setExtraUsageWarning,
  setProviderAllocationsSource,
  warningForProvider,
  worstProviderWarning,
} from "@/engine/session/usage/limits.ts";
import { providerRouteability } from "@/engine/session/usage/provider-routeability.ts";
import { applyScopedQuotaWarnings } from "@/engine/session/usage/quota-warning.ts";
import { PROVIDER_ID_VALUES } from "@/kernel/std/types/provider-ids.ts";

function makeAllocationWorkflowTask(
  id: string,
  provider: WorkflowTaskLifecycle["provider"],
  state: "start" | "done",
): WorkflowTaskLifecycle {
  return {
    id,
    type: "local_workflow",
    status: "running",
    parentToolCallId: `tool-${id}`,
    workflowRunId: `run-${id}`,
    cwd: "/tmp",
    sessionId: "session-alloc",
    workflowName: "alloc-test",
    description: "allocation scope workflow",
    workflowProgress: [
      {
        type: "workflow_agent",
        index: 0,
        label: "stage-0",
        ...(provider !== undefined ? { provider } : {}),
        state,
        startedAt: Date.now(),
        lastProgressAt: Date.now(),
      },
    ],
    progressVersion: 0,
    agentCount: 1,
    totalTokens: 0,
    totalToolCalls: 0,
    logs: [],
    startedAt: Date.now(),
    abortController: new AbortController(),
  };
}

describe("bug-report scenario end to end", () => {
  it("opening /usage codex tab seeds SoT but passive warning never surfaces when codex is idle", () => {
    clearRoutingUsage();
    clearUsageLimits();
    for (const p of PROVIDER_ID_VALUES) setExtraUsageWarning(p, null);

    // 1. user opens /usage codex tab: 84% weekly — amber-worthy, codex idle.
    applyCodexQuotaWarning({
      primary: { utilization: 20, windowMinutes: 300, resetsAt: null },
      secondary: { utilization: 84, windowMinutes: 10080, resetsAt: null },
      rateLimitReachedType: null,
    });
    // Panel (explicit surface) still sees it:
    expect(warningForProvider("codex")?.message).toContain("84%");

    // 2. session allocation = glm only (main provider), no codex agents.
    setProviderAllocationsSource(() => [{ provider: "glm" }]);
    // Any later quota mutation recomputes the worst warning — codex must NOT surface.
    expect(worstProviderWarning()).toBeNull();

    // 3. a codex-pinned delegated agent starts running → codex is allocated.
    setProviderAllocationsSource(() => [{ provider: "glm" }, { provider: "codex" }]);
    expect(worstProviderWarning()?.message).toContain("84%");

    // 4. codex reports real exhaustion → routing blocks + error warning, same SoT.
    applyCodexQuotaWarning({
      primary: { utilization: 34, windowMinutes: 300, resetsAt: null },
      secondary: { utilization: 99, windowMinutes: 10080, resetsAt: "2199-01-01T00:00:00Z" },
      rateLimitReachedType: "rate_limit_reached",
    });
    expect(providerRouteability("codex").usable).toBe(false);
    expect(providerRouteability("codex", "codex").usable).toBe(false); // no exemption
    expect(worstProviderWarning()?.severity).toBe("error");

    // 5. refresh shows recovery → immediately usable, warning gone.
    applyCodexQuotaWarning({
      primary: { utilization: 34, windowMinutes: 300, resetsAt: null },
      secondary: { utilization: 12, windowMinutes: 10080, resetsAt: null },
      rateLimitReachedType: null,
    });
    expect(providerRouteability("codex").usable).toBe(true);
    expect(worstProviderWarning()).toBeNull();

    setProviderAllocationsSource(null);
    clearRoutingUsage();
    for (const p of PROVIDER_ID_VALUES) setExtraUsageWarning(p, null);
  });
});

describe("workflow stage allocation", () => {
  it("an exhausted provider used only by a running workflow stage enters the passive scope", () => {
    clearRoutingUsage();
    clearUsageLimits();
    for (const p of PROVIDER_ID_VALUES) setExtraUsageWarning(p, null);

    enrollWorkflowTask(makeAllocationWorkflowTask("wf-alloc-1", "codex", "start"));
    // The subscriber composes: active provider + background tasks + workflow stages.
    setProviderAllocationsSource(() => [
      { provider: "glm" },
      ...listActiveWorkflowAgentAllocations(),
    ]);

    applyCodexQuotaWarning({
      primary: { utilization: 34, windowMinutes: 300, resetsAt: null },
      secondary: { utilization: 99, windowMinutes: 10080, resetsAt: "2199-01-01T00:00:00Z" },
      rateLimitReachedType: "rate_limit_reached",
    });
    expect(worstProviderWarning()?.severity).toBe("error");

    // Stage finishes → codex leaves the allocation set on the next evaluation.
    updateWorkflowTask("wf-alloc-1", { status: "completed" });
    expect(worstProviderWarning()).toBeNull();

    setProviderAllocationsSource(null);
    resetWorkflowTasksForTests();
    clearRoutingUsage();
    for (const p of PROVIDER_ID_VALUES) setExtraUsageWarning(p, null);
  });
});

describe("model-scope allocation matching", () => {
  function resetQuotaState(): void {
    clearRoutingUsage();
    clearUsageLimits();
    for (const p of PROVIDER_ID_VALUES) setExtraUsageWarning(p, null);
  }

  it("a family scope's warning surfaces only while a matching model is allocated; global scopes reach every model", () => {
    resetQuotaState();
    applyScopedQuotaWarnings("anthropic", [
      {
        scopeKey: "seven_day",
        displayLabel: "Weekly limit",
        applicability: { type: "global" },
        label: "weekly",
        utilization: 80,
        resetsAt: "2199-01-01T00:00:00Z",
      },
      {
        scopeKey: "seven_day_fable",
        displayLabel: "Fable weekly limit",
        applicability: { type: "family", id: "fable" },
        label: "fable",
        utilization: 100,
        resetsAt: "2199-01-01T00:00:00Z",
      },
    ]);

    // Session on opus: the exhausted Fable family scope must NOT surface, but
    // the shared weekly window (global scope) reaches any model of the provider.
    setProviderAllocationsSource(() => [{ provider: "anthropic", model: "claude-opus-4-8" }]);
    const opusOnly = worstProviderWarning();
    expect(opusOnly?.severity).toBe("warning");
    expect(opusOnly?.message).toContain("80%");

    // A running Fable subagent joins → the family scope becomes viable NOW.
    setProviderAllocationsSource(() => [
      { provider: "anthropic", model: "claude-opus-4-8" },
      { provider: "anthropic", model: "claude-fable-5" },
    ]);
    expect(worstProviderWarning()?.severity).toBe("error");

    // Subagent finished → the family warning stops surfacing on the next
    // evaluation (never after the fact).
    setProviderAllocationsSource(() => [{ provider: "anthropic", model: "claude-opus-4-8" }]);
    expect(worstProviderWarning()?.severity).toBe("warning");

    // Explicit surfaces stay unscoped: the panel still sees the worst scope.
    expect(warningForProvider("anthropic")?.severity).toBe("error");

    setProviderAllocationsSource(null);
    resetQuotaState();
  });

  it("an unknown-model allocation matches only provider-wide scopes", () => {
    resetQuotaState();
    applyScopedQuotaWarnings("codex", [
      {
        scopeKey: "spark",
        displayLabel: "Spark weekly limit",
        applicability: { type: "family", id: "spark" },
        label: "spark",
        utilization: 100,
        resetsAt: "2199-01-01T00:00:00Z",
      },
    ]);

    setProviderAllocationsSource(() => [{ provider: "codex" }]);
    expect(worstProviderWarning()).toBeNull();

    setProviderAllocationsSource(() => [{ provider: "codex", model: "gpt-5.3-codex-spark" }]);
    expect(worstProviderWarning()?.severity).toBe("error");

    setProviderAllocationsSource(null);
    resetQuotaState();
  });
});
