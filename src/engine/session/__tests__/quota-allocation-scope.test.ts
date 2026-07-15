import { describe, expect, it } from "bun:test";
import {
  listActiveWorkflowAgentProviders,
  registerWorkflowTask,
  resetWorkflowTasksForTests,
  updateWorkflowTask,
} from "@/engine/background/workflows/runtime/store/store.ts";
import type { LocalWorkflowTaskState } from "@/engine/background/workflows/runtime/store/types.ts";
import { applyCodexQuotaWarning } from "@/engine/providers/codex/usage.ts";
import {
  clearRoutingUsage,
  clearUsageLimits,
  setAllocatedProvidersSource,
  setExtraUsageWarning,
  warningForProvider,
  worstProviderWarning,
} from "@/engine/session/usage/limits.ts";
import { providerRouteability } from "@/engine/session/usage/provider-routeability.ts";
import { PROVIDER_ID_VALUES } from "@/kernel/config/provider-ids.ts";

function makeAllocationWorkflowTask(
  id: string,
  provider: LocalWorkflowTaskState["provider"],
  state: "start" | "done",
): LocalWorkflowTaskState {
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
    setAllocatedProvidersSource(() => ["glm"]);
    // Any later quota mutation recomputes the worst warning — codex must NOT surface.
    expect(worstProviderWarning()).toBeNull();

    // 3. a codex-pinned delegated agent starts running → codex is allocated.
    setAllocatedProvidersSource(() => ["glm", "codex"]);
    expect(worstProviderWarning()?.message).toContain("84%");

    // 4. codex reports real exhaustion → routing blocks + error warning, same SoT.
    applyCodexQuotaWarning({
      primary: { utilization: 34, windowMinutes: 300, resetsAt: null },
      secondary: { utilization: 99, windowMinutes: 10080, resetsAt: "2199-01-01T00:00:00Z" },
      rateLimitReachedType: "secondary_window",
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

    setAllocatedProvidersSource(null);
    clearRoutingUsage();
    for (const p of PROVIDER_ID_VALUES) setExtraUsageWarning(p, null);
  });
});

describe("workflow stage allocation", () => {
  it("an exhausted provider used only by a running workflow stage enters the passive scope", () => {
    clearRoutingUsage();
    clearUsageLimits();
    for (const p of PROVIDER_ID_VALUES) setExtraUsageWarning(p, null);

    registerWorkflowTask(makeAllocationWorkflowTask("wf-alloc-1", "codex", "start"));
    // The subscriber composes: active provider + background tasks + workflow stages.
    setAllocatedProvidersSource(() => ["glm", ...listActiveWorkflowAgentProviders()]);

    applyCodexQuotaWarning({
      primary: { utilization: 34, windowMinutes: 300, resetsAt: null },
      secondary: { utilization: 99, windowMinutes: 10080, resetsAt: "2199-01-01T00:00:00Z" },
      rateLimitReachedType: "secondary_window",
    });
    expect(worstProviderWarning()?.severity).toBe("error");

    // Stage finishes → codex leaves the allocation set on the next evaluation.
    updateWorkflowTask("wf-alloc-1", { status: "completed" });
    expect(worstProviderWarning()).toBeNull();

    setAllocatedProvidersSource(null);
    resetWorkflowTasksForTests();
    clearRoutingUsage();
    for (const p of PROVIDER_ID_VALUES) setExtraUsageWarning(p, null);
  });
});
