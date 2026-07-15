import { listRunning } from "@/engine/background/tasks/background.ts";
import {
  listActiveWorkflowAgentProviders,
  subscribeWorkflowTasks,
} from "@/engine/background/workflows/runtime/store/store.ts";
import { setAllocatedProvidersSource } from "@/engine/session/usage/limits.ts";
import {
  getUsageLimitSnapshot,
  subscribeUsageLimits,
  type UsageLimitSnapshot,
  type UsageWarning,
  worstProviderWarning,
} from "@/kernel/channels/usage-limits.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { createAutoClearDispatch } from "@/kernel/std/state/auto-clear-dispatch.ts";
import { dispatch } from "@/store/app-store/index.ts";

const WARNING_DISPLAY_MS = 8000;
const WARNING_RESHOW_COOLDOWN_MS = 120_000;

const warningDispatch = createAutoClearDispatch<string>({ holdMs: WARNING_DISPLAY_MS });
const lastShownAt = new Map<string, number>();

function showWarning(warning: UsageWarning): void {
  const key = `${warning.severity}:${warning.message}`;
  if (warningDispatch.isArmed(key)) return;
  const now = Date.now();
  const last = lastShownAt.get(key);
  if (last !== undefined && now - last < WARNING_RESHOW_COOLDOWN_MS) return;
  lastShownAt.set(key, now);
  dispatch({ type: "view/setUsageWarning", warning });
  warningDispatch.arm({
    key,
    onTimeout: () => dispatch({ type: "view/clearUsageWarningIfKey", key }),
  });
}

function publishSnapshot(): void {
  dispatch({ type: "engine/setSlice", key: "usageLimitSnapshot", value: getUsageLimitSnapshot() });
}

/**
 * The live allocation set: the active provider, running delegated agents'
 * providers, and providers of stage agents inside running workflows (stage
 * agents never enter the background-task store).
 */
function allocatedProvidersNow(broker: UsageLimitsBroker): ProviderId[] {
  const allocated: ProviderId[] = [broker.read().provider];
  for (const task of listRunning()) {
    if (task.provider !== undefined) allocated.push(task.provider);
  }
  allocated.push(...listActiveWorkflowAgentProviders());
  return allocated;
}

interface UsageLimitsBroker {
  read(): { provider: ProviderId };
}

/**
 * Mirrors the usage SoT into the app store and auto-shows the worst warning.
 * With a broker, the passive warning is allocation-scoped: worstProviderWarning
 * only considers the main session's active provider plus providers of running
 * delegated agents/workflow stages, so quota state observed for an idle
 * provider (a /usage tab open, the companion's full-roster poll) never
 * resurfaces on its own.
 */
export function startUsageLimitsSubscriber(broker?: UsageLimitsBroker): () => void {
  if (broker !== undefined) {
    setAllocatedProvidersSource(() => allocatedProvidersNow(broker));
  }
  publishSnapshot();
  const reevaluateWarning = (): void => {
    const warning = worstProviderWarning();
    if (warning) showWarning(warning);
  };
  const unsub = subscribeUsageLimits(() => {
    publishSnapshot();
    reevaluateWarning();
  });
  // Allocation growth (a workflow stage starting on a new provider) must
  // re-evaluate against the CURRENT observation — the SoT itself only emits
  // on refresh, which can lag the allocation change by minutes.
  let lastAllocationKey = "";
  const unsubWorkflows =
    broker === undefined
      ? null
      : subscribeWorkflowTasks(() => {
          const key = [...new Set(allocatedProvidersNow(broker))].sort().join(",");
          if (key === lastAllocationKey) return;
          lastAllocationKey = key;
          reevaluateWarning();
        });
  return () => {
    unsub();
    unsubWorkflows?.();
    if (broker !== undefined) setAllocatedProvidersSource(null);
    warningDispatch.clear();
    lastShownAt.clear();
  };
}

export function readUsageLimitSnapshotSlice(
  engine: Readonly<Record<string, unknown>>,
): UsageLimitSnapshot | undefined {
  const value = engine.usageLimitSnapshot;
  if (value === undefined) return undefined;
  return value as UsageLimitSnapshot;
}
