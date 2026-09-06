import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { resetWorkflowTasksForTests } from "@/engine/background/workflows/runtime/store/store.ts";
import * as noticesModule from "@/store/app-store/right-region-notices.ts";

const realNoticesModule = { ...noticesModule };

const submitQuotaWarningCalls: Array<{ message: string; severity: "warning" | "error" }> = [];
let clearQuotaWarningCalls = 0;

mock.module("@/store/app-store/right-region-notices.ts", () => ({
  ...realNoticesModule,
  submitQuotaWarning: (message: string, severity: "warning" | "error") => {
    submitQuotaWarningCalls.push({ message, severity });
  },
  clearQuotaWarning: () => {
    clearQuotaWarningCalls += 1;
  },
}));

import {
  clearRoutingUsage,
  clearUsageLimits,
  setProviderAllocationsSource,
} from "@/engine/session/usage/limits.ts";
import {
  applyScopedQuotaWarnings,
  type ScopedQuotaCandidate,
} from "@/engine/session/usage/quota-warning.ts";
import { startUsageLimitsSubscriber } from "@/store/subscribers/usage-limits.ts";

function warningScope(utilization: number, scopeKey = "session"): ScopedQuotaCandidate {
  return {
    scopeKey,
    displayLabel: scopeKey === "session" ? "Session" : "Weekly",
    applicability: { type: "global" },
    label: scopeKey === "session" ? "Session" : "Weekly",
    utilization,
    resetsAt: null,
    trackingStatus: "tracked",
  };
}

function anthropicOnlyBroker() {
  return {
    read: () => ({ provider: "anthropic" as const, model: "claude-test" }),
    select: () => () => {},
  };
}

describe("usage-limits subscriber (show-once-per-text passive warning)", () => {
  let stop: (() => void) | null = null;

  afterEach(() => {
    stop?.();
    stop = null;
    submitQuotaWarningCalls.length = 0;
    clearQuotaWarningCalls = 0;
    setProviderAllocationsSource(null);
    clearRoutingUsage();
    clearUsageLimits();
    resetWorkflowTasksForTests();
  });

  afterAll(() => {
    mock.module("@/store/app-store/right-region-notices.ts", () => realNoticesModule);
  });

  it("flashes on every text change and never re-submits an identical message", () => {
    stop = startUsageLimitsSubscriber(anthropicOnlyBroker());

    applyScopedQuotaWarnings("anthropic", [warningScope(72)]);
    expect(submitQuotaWarningCalls).toEqual([
      { message: "[Anthropic] 72% Session · resets unknown", severity: "warning" },
    ]);

    // A refresh reporting the identical observation re-emits through the SoT,
    // but the flash must not repeat.
    applyScopedQuotaWarnings("anthropic", [warningScope(72)]);
    expect(submitQuotaWarningCalls).toHaveLength(1);

    // A percentage tick is a new text: flash immediately, no cooldown.
    applyScopedQuotaWarnings("anthropic", [warningScope(73)]);
    expect(submitQuotaWarningCalls).toHaveLength(2);
    expect(submitQuotaWarningCalls[1]?.message).toBe("[Anthropic] 73% Session · resets unknown");
  });

  it("keeps the guard across clears: a cleared warning returning with the same text stays silent", () => {
    stop = startUsageLimitsSubscriber(anthropicOnlyBroker());

    applyScopedQuotaWarnings("anthropic", [warningScope(73)]);
    expect(submitQuotaWarningCalls).toHaveLength(1);

    applyScopedQuotaWarnings("anthropic", []);
    expect(clearQuotaWarningCalls).toBeGreaterThan(0);

    applyScopedQuotaWarnings("anthropic", [warningScope(73)]);
    expect(submitQuotaWarningCalls).toHaveLength(1);

    applyScopedQuotaWarnings("anthropic", [warningScope(74)]);
    expect(submitQuotaWarningCalls).toHaveLength(2);
  });

  it("a different worst scope is a new text and flashes even at the same utilization", () => {
    stop = startUsageLimitsSubscriber(anthropicOnlyBroker());

    applyScopedQuotaWarnings("anthropic", [warningScope(72)]);
    expect(submitQuotaWarningCalls).toHaveLength(1);

    applyScopedQuotaWarnings("anthropic", [warningScope(72), warningScope(80, "weekly")]);
    expect(submitQuotaWarningCalls).toHaveLength(2);
    expect(submitQuotaWarningCalls[1]?.message).toBe("[Anthropic] 80% Weekly · resets unknown");

    // Back to the single session scope: the previous text was already shown,
    // but it is not the last shown text, so it flashes again (single-slot guard).
    applyScopedQuotaWarnings("anthropic", [warningScope(72)]);
    expect(submitQuotaWarningCalls).toHaveLength(3);
    expect(submitQuotaWarningCalls[2]?.message).toBe("[Anthropic] 72% Session · resets unknown");
  });
});
