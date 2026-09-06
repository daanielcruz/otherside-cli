import { cpus } from "node:os";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";

const WORKFLOW_PLAN_TIERS: Partial<Record<ProviderId, Record<string, number>>> = {
  glm: { lite: 1, pro: 2, max: 7 },
  minimax: { plus: 4, max: 5, ultra: 7 },
};

const WORKFLOW_FIXED_CONCURRENCY: Partial<Record<ProviderId, number>> = {
  antigravity: 8,
};

const WORKFLOW_DEFAULT_PLAN: Partial<Record<ProviderId, string>> = {
  glm: "lite",
  minimax: "plus",
};

function providerEnvKey(provider: ProviderId): string {
  return provider.toUpperCase().replace("-", "_");
}

function workflowConcurrencyForProvider(
  provider: ProviderId,
  realPlan: string | null,
): number | undefined {
  const direct = process.env[`OTHERSIDE_${providerEnvKey(provider)}_CONCURRENCY`];
  if (direct) {
    const parsed = Number.parseInt(direct, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const fixed = WORKFLOW_FIXED_CONCURRENCY[provider];
  if (fixed) return fixed;
  const tiers = WORKFLOW_PLAN_TIERS[provider];
  if (!tiers) return undefined;
  const plan =
    process.env[`OTHERSIDE_${providerEnvKey(provider)}_PLAN`] ??
    realPlan ??
    WORKFLOW_DEFAULT_PLAN[provider];
  if (!plan) return undefined;
  return tiers[plan];
}

// Sampled once per workflow run (at bridge creation) and threaded through the
// call chain, rather than re-read on every gate check, so one run's cap stays
// pinned to a single snapshot of the machine's core count.
export function computeWorkflowCpuCount(): number {
  return cpus().length;
}

// A provider with no configured limit runs up to this machine-scaled default,
// so a single-provider workflow behaves exactly as before (no joint ceiling).
function uncappedProviderDefault(cpuCount: number): number {
  return Math.min(16, Math.max(2, cpuCount - 2));
}

export function workflowConcurrencyLimit(
  provider?: ProviderId,
  plan?: string | null,
  cpuCount: number = computeWorkflowCpuCount(),
): number {
  const fallback = uncappedProviderDefault(cpuCount);
  if (!provider) return fallback;
  const capped = workflowConcurrencyForProvider(provider, plan ?? null);
  return capped ?? fallback;
}

interface Semaphore {
  running: number;
  limit: number;
  queue: (() => void)[];
}

function acquireSlot(sem: Semaphore): Promise<void> {
  if (sem.running < sem.limit) {
    sem.running += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => sem.queue.push(resolve));
}

// Hand the freed slot straight to the next waiter — the slot transfers, so
// `running` stays put; only decrement when nobody is queued.
function releaseSlot(sem: Semaphore): void {
  const next = sem.queue.shift();
  if (next) {
    next();
    return;
  }
  sem.running -= 1;
}

export interface ConcurrencyGateDeps {
  /** Per-provider concurrency limit for the RESOLVED provider of an agent. */
  limitFor: (provider: ProviderId) => Promise<number>;
}

export interface ConcurrencyGate {
  acquire: (provider: ProviderId) => Promise<void>;
  release: (provider: ProviderId) => void;
}

/**
 * Pure per-provider gate: every agent obeys ONLY its resolved provider's own
 * limit, so a glm agent capped at 1 never throttles a codex sibling running at
 * its own limit. There is no joint ceiling — total in-flight is the sum of the
 * active per-provider pools.
 */
export function createConcurrencyGate(deps: ConcurrencyGateDeps): ConcurrencyGate {
  // Keyed by a promise so two concurrent first-acquires of the same provider
  // await one shared pool instead of racing to create two.
  const pools = new Map<ProviderId, Promise<Semaphore>>();
  const resolved = new Map<ProviderId, Semaphore>();

  const poolFor = (provider: ProviderId): Promise<Semaphore> => {
    const existing = pools.get(provider);
    if (existing) return existing;
    const pending = deps
      .limitFor(provider)
      .then((limit) => ({ running: 0, limit, queue: [] }) as Semaphore);
    pools.set(provider, pending);
    return pending;
  };

  return {
    acquire: async (provider) => {
      const pool = await poolFor(provider);
      resolved.set(provider, pool);
      await acquireSlot(pool);
    },
    release: (provider) => {
      const pool = resolved.get(provider);
      if (pool) releaseSlot(pool);
    },
  };
}
