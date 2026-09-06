import {
  listRunning,
  subscribe as subscribeBackgroundTasks,
} from "@/engine/background/tasks/background.ts";
import {
  listActiveWorkflowAgentAllocations,
  subscribeWorkflowTasks,
} from "@/engine/background/workflows/runtime/store/store.ts";
import { setProviderAllocationsSource } from "@/engine/session/usage/limits.ts";
import {
  getUsageLimitSnapshot,
  type ProviderAllocation,
  subscribeUsageLimits,
  type UsageLimitSnapshot,
  type UsageWarning,
  worstProviderWarning,
} from "@/kernel/channels/usage-limits.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import { dispatch } from "@/store/app-store/index.ts";
import { clearQuotaWarning, submitQuotaWarning } from "@/store/app-store/right-region-notices.ts";

function showWarning(warning: UsageWarning): void {
  submitQuotaWarning(warning.message, warning.severity);
}

function publishSnapshot(): void {
  dispatch({ type: "engine/setSlice", key: "usageLimitSnapshot", value: getUsageLimitSnapshot() });
}

/**
 * The live allocation set as (provider, model) routes: the active session
 * route, running delegated agents' routes, and routes of stage agents inside
 * running workflows (stage agents never enter the background-task store).
 */
function allocationsNow(broker: UsageLimitsBroker): ProviderAllocation[] {
  const state = broker.read();
  const allocations: ProviderAllocation[] = [{ provider: state.provider, model: state.model }];
  for (const task of listRunning()) {
    if (task.provider === undefined) continue;
    allocations.push(
      task.model === undefined
        ? { provider: task.provider }
        : { provider: task.provider, model: task.model },
    );
  }
  allocations.push(...listActiveWorkflowAgentAllocations());
  return allocations;
}

interface UsageLimitsBroker {
  read(): { provider: ProviderId; model: string };
  select<T>(
    selector: (state: { provider: ProviderId; model: string }) => T,
    subscriber: (value: T) => void,
  ): () => void;
}

/**
 * Mirrors the usage SoT into the app store and auto-shows the worst warning.
 * With a broker, the passive warning is allocation-scoped: worstProviderWarning
 * only considers the (provider, model) routes of the main session plus running
 * delegated agents/workflow stages, so quota state observed for an idle
 * provider (a /usage tab open, the companion's full-roster poll) — or for a
 * family/model scope no allocated route uses — never resurfaces on its own.
 *
 * Display is owned by the right-region notice controller (ephemeralSolo lane).
 */
export function startUsageLimitsSubscriber(broker?: UsageLimitsBroker): () => void {
  if (broker !== undefined) {
    setProviderAllocationsSource(() => allocationsNow(broker));
  }
  publishSnapshot();
  // Show-once-per-text: the passive warning flashes only when its rendered
  // text changes (percentage ticks, a different scope/provider becoming the
  // worst, reset-time updates). An identical message is never re-submitted —
  // even after the flash expires or the warning clears and returns.
  let lastShownMessage: string | null = null;
  const reevaluateWarning = (): void => {
    const warning = worstProviderWarning();
    if (warning === null) {
      clearQuotaWarning();
      return;
    }
    if (warning.message === lastShownMessage) return;
    lastShownMessage = warning.message;
    showWarning(warning);
  };
  const unsub = subscribeUsageLimits(() => {
    publishSnapshot();
    reevaluateWarning();
  });
  // Allocation growth (a delegated agent or workflow stage starting on a new
  // route) must re-evaluate against the CURRENT observation — the SoT itself
  // only emits on refresh, which can lag the allocation change by minutes.
  // Evaluations after a route ends naturally exclude it, so a scope's warning
  // is only ever shown while a matching route is live.
  let lastAllocationKey = "";
  const onAllocationsChanged =
    broker === undefined
      ? null
      : (): void => {
          const key = [
            ...new Set(allocationsNow(broker).map((a) => `${a.provider}\u0000${a.model ?? ""}`)),
          ]
            .sort()
            .join(",");
          if (key === lastAllocationKey) return;
          lastAllocationKey = key;
          reevaluateWarning();
        };
  const unsubWorkflows = onAllocationsChanged && subscribeWorkflowTasks(onAllocationsChanged);
  const unsubTasks = onAllocationsChanged && subscribeBackgroundTasks(onAllocationsChanged);
  const unsubBroker =
    broker === undefined || onAllocationsChanged === null
      ? null
      : broker.select((state) => `${state.provider}\u0000${state.model}`, onAllocationsChanged);
  onAllocationsChanged?.();
  return () => {
    unsub();
    if (unsubWorkflows) unsubWorkflows();
    if (unsubTasks) unsubTasks();
    unsubBroker?.();
    if (broker !== undefined) setProviderAllocationsSource(null);
    clearQuotaWarning();
  };
}

export function readUsageLimitSnapshotSlice(
  engine: Readonly<Record<string, unknown>>,
): UsageLimitSnapshot | undefined {
  const value = engine.usageLimitSnapshot;
  if (value === undefined) return undefined;
  return value as UsageLimitSnapshot;
}
