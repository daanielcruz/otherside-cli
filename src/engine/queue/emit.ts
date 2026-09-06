import {
  BOUNDARY_POLICY,
  type CancelResult,
  DELIVERY_BANDS,
  type DrainResult,
  type EmitBoundary,
  type EmitClass,
  type EmitItem,
  type EmitItemInput,
  PRIORITY_ORDER,
  type PriorityStateSnapshot,
} from "@/engine/queue/priority.ts";
import { projectDrain } from "@/engine/queue/projection.ts";
import { resolveConfig } from "@/kernel/config/resolver.ts";
import type { NotificationCtx } from "@/kernel/hooks/events.ts";
import { fireConfiguredHooks } from "@/kernel/hooks/handler.ts";
import { makeStore } from "@/kernel/std/state/make-store.ts";

interface AwaiterEntry {
  filter: { class: EmitClass; ownerId?: string };
  resolve: (item: EmitItem) => void;
  reject: (err: Error) => void;
}

function emptySizes(): Record<EmitClass, number> {
  return {
    interrupt_bash: 0,
    urgent_output: 0,
    deferred_output: 0,
    idle_prompt: 0,
  };
}

const initialState: PriorityStateSnapshot = {
  sizes: emptySizes(),
  hasPendingAutoTurn: false,
  turnActive: false,
};

const stateStore = makeStore<PriorityStateSnapshot>(initialState);

const subQueues: Record<EmitClass, EmitItem[]> = {
  interrupt_bash: [],
  urgent_output: [],
  deferred_output: [],
  idle_prompt: [],
};

const consumedStickyKeys = new Set<string>();
const consumedReplayKeys = new Set<string>();
const MAX_CONSUMED_REPLAY_KEYS = 1_024;
const activeOwners = new Map<string, Set<unknown>>();
const ownerLifecycleCallbacks = new Map<string, OwnerLifecycleCallbacks>();
const awaiters: AwaiterEntry[] = [];

export interface OwnerReleaseDisposition {
  promotedReplayKeys: readonly string[];
}

export interface OwnerLifecycleCallbacks {
  onInventoryConsumed?: (replayKeys: readonly string[]) => void;
  onOwnerRelease?: (disposition: OwnerReleaseDisposition) => void;
}
const drainListeners = new Set<(result: DrainResult, boundary: EmitBoundary) => void>();

type NotificationHookRunner = (ctx: NotificationCtx) => void;

function defaultNotificationHookRunner(ctx: NotificationCtx): void {
  queueMicrotask(() => {
    try {
      void fireConfiguredHooks(resolveConfig(process.cwd()), "Notification", {
        kind: "Notification",
        ctx,
      }).catch(() => {});
    } catch {}
  });
}

let notificationHookRunner: NotificationHookRunner = defaultNotificationHookRunner;

let idCounter = 0;
let turnActive = false;

/** Identity plus arrival order, so two items of the same millisecond still order. */
function nextArrival(): { id: string; seq: number } {
  idCounter += 1;
  return { id: `eq_${Date.now().toString(36)}_${idCounter.toString(36)}`, seq: idCounter };
}

function syncStateSnapshot(): void {
  const sizes = emptySizes();
  let pendingAuto = false;
  for (const klass of PRIORITY_ORDER) {
    sizes[klass] = subQueues[klass].length;
    if (!pendingAuto) {
      for (const item of subQueues[klass]) {
        if (item.autoTurn !== false && item.target !== "inventory" && item.target !== "none") {
          pendingAuto = true;
          break;
        }
      }
    }
  }
  stateStore.setState(() => ({
    sizes,
    hasPendingAutoTurn: pendingAuto,
    turnActive,
  }));
}

function spliceReplaceByReplayKey(item: EmitItem): boolean {
  if (item.replayKey === undefined) return false;
  const queue = subQueues[item.class];
  for (let i = 0; i < queue.length; i += 1) {
    const existing = queue[i];
    if (existing === undefined) continue;
    if (existing.replayKey === item.replayKey) {
      queue.splice(i, 1, item);
      return true;
    }
  }
  return false;
}

function enqueue(item: EmitItem): void {
  if (
    item.sticky === true &&
    item.replayKey !== undefined &&
    consumedStickyKeys.has(item.replayKey)
  ) {
    return;
  }
  if (item.replayKey !== undefined) consumedReplayKeys.delete(item.replayKey);
  if (spliceReplaceByReplayKey(item)) {
    syncStateSnapshot();
    return;
  }
  subQueues[item.class].push(item);
  syncStateSnapshot();
}

function targetCompatibleWithPolicyEntry(
  itemTarget: EmitItem["target"],
  policyTarget: EmitItem["target"],
): boolean {
  if (itemTarget === "none") return false;
  if (itemTarget === "inventory") return false;
  if (itemTarget === policyTarget) return true;
  if (itemTarget === "both") return true;
  if (policyTarget === "both") return true;
  return false;
}

interface DrainPlan {
  picked: EmitItem[];
  consumedIds: Set<string>;
}

function planDrain(boundary: EmitBoundary): DrainPlan {
  const policy = BOUNDARY_POLICY[boundary];
  const eligibleByClass = new Map<EmitClass, EmitItem["target"]>();
  for (const entry of policy.entries) {
    if (!eligibleByClass.has(entry.class)) eligibleByClass.set(entry.class, entry.target);
  }
  const picked: EmitItem[] = [];
  const consumedIds = new Set<string>();
  for (const band of DELIVERY_BANDS) {
    // A band is one delivery lane, so what separates its items is when they
    // arrived, not which class they were filed under.
    const arrived: EmitItem[] = [];
    for (const klass of band) {
      const policyTarget = eligibleByClass.get(klass);
      if (policyTarget === undefined) continue;
      for (const item of subQueues[klass]) {
        if (!targetCompatibleWithPolicyEntry(item.target, policyTarget)) continue;
        arrived.push(item);
      }
    }
    arrived.sort((a, b) => a.seq - b.seq);
    for (const item of arrived) {
      picked.push(item);
      consumedIds.add(item.id);
    }
  }
  return { picked, consumedIds };
}

function markReplayKeyConsumed(replayKey: string): void {
  if (consumedReplayKeys.has(replayKey)) return;
  if (consumedReplayKeys.size >= MAX_CONSUMED_REPLAY_KEYS) {
    const oldest = consumedReplayKeys.values().next().value;
    if (oldest !== undefined) consumedReplayKeys.delete(oldest);
  }
  consumedReplayKeys.add(replayKey);
}

function commitDrain(consumedIds: Set<string>, sync = true): void {
  if (consumedIds.size === 0) return;
  for (const klass of PRIORITY_ORDER) {
    const queue = subQueues[klass];
    if (queue.length === 0) continue;
    const next: EmitItem[] = [];
    for (const item of queue) {
      if (consumedIds.has(item.id)) {
        if (item.replayKey !== undefined) {
          markReplayKeyConsumed(item.replayKey);
          if (item.sticky === true) consumedStickyKeys.add(item.replayKey);
        }
        continue;
      }
      next.push(item);
    }
    queue.length = 0;
    for (const item of next) queue.push(item);
  }
  if (sync) syncStateSnapshot();
}

function notificationCtxForItem(item: EmitItem): NotificationCtx | null {
  if (item.payload.kind !== "task_notification_xml") return null;
  return {
    hook_event_name: "Notification",
    message: item.payload.summary ?? item.payload.text,
    notification_type: "agent_completed",
  };
}

export function fireNotificationHook(ctx: NotificationCtx): void {
  try {
    notificationHookRunner(ctx);
  } catch {}
}

function fireNotificationHooksForDrain(items: readonly EmitItem[]): void {
  for (const item of items) {
    const ctx = notificationCtxForItem(item);
    if (ctx === null) continue;
    fireNotificationHook(ctx);
  }
}

function tryDeliverToAwaitersForDrain(items: readonly EmitItem[]): Set<string> {
  const delivered = new Set<string>();
  if (items.length === 0 || awaiters.length === 0) return delivered;
  for (const item of items) {
    for (let i = 0; i < awaiters.length; i += 1) {
      const entry = awaiters[i];
      if (entry === undefined) continue;
      if (entry.filter.class !== item.class) continue;
      if (entry.filter.ownerId !== undefined && entry.filter.ownerId !== item.ownerId) continue;
      awaiters.splice(i, 1);
      delivered.add(item.id);
      entry.resolve(item);
      break;
    }
  }
  return delivered;
}

function releaseOwnerInventory(ownerId: string): void {
  activeOwners.delete(ownerId);
  const promotedReplayKeys: string[] = [];
  let changed = false;
  for (const klass of PRIORITY_ORDER) {
    for (const item of subQueues[klass]) {
      if (item.ownerId !== ownerId || item.target !== "inventory") continue;
      item.target = "both";
      if (item.replayKey !== undefined) promotedReplayKeys.push(item.replayKey);
      changed = true;
    }
  }
  ownerLifecycleCallbacks.get(ownerId)?.onOwnerRelease?.({ promotedReplayKeys });
  if (changed) syncStateSnapshot();
}

function hasOwnerInventory(ownerId: string): boolean {
  for (const klass of PRIORITY_ORDER) {
    if (subQueues[klass].some((item) => item.ownerId === ownerId && item.target === "inventory")) {
      return true;
    }
  }
  return false;
}

export interface EmitForCompletionInput {
  class: "urgent_output" | "deferred_output";
  ownerId: string | undefined;
  isSubagentOwned: boolean;
  payload: EmitItemInput["payload"];
  autoTurn?: boolean;
  replayKey?: string;
}

export const emitQueue = {
  registerOwner(ownerId: string, callbacks?: OwnerLifecycleCallbacks): () => void {
    const token = {};
    let tokens = activeOwners.get(ownerId);
    if (!tokens) {
      tokens = new Set<unknown>();
      activeOwners.set(ownerId, tokens);
    }
    if (callbacks !== undefined) ownerLifecycleCallbacks.set(ownerId, callbacks);
    tokens.add(token);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const currentTokens = activeOwners.get(ownerId);
      if (currentTokens) {
        currentTokens.delete(token);
        if (currentTokens.size === 0) {
          releaseOwnerInventory(ownerId);
          ownerLifecycleCallbacks.delete(ownerId);
        }
      }
    };
  },

  isOwnerRegistered(ownerId: string): boolean {
    return activeOwners.has(ownerId);
  },

  emit(input: EmitItemInput): string {
    const item: EmitItem = {
      ...input,
      ...nextArrival(),
      ts: Date.now(),
    };
    enqueue(item);
    return item.id;
  },

  emitForCompletion(input: EmitForCompletionInput): string {
    const routeToOwner =
      input.isSubagentOwned && input.ownerId !== undefined && activeOwners.has(input.ownerId);
    const target: EmitItemInput["target"] = routeToOwner ? "inventory" : "both";
    return emitQueue.emit({
      class: input.class,
      target,
      payload: input.payload,
      ...(input.autoTurn !== undefined ? { autoTurn: input.autoTurn } : {}),
      ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      ...(input.replayKey !== undefined ? { replayKey: input.replayKey } : {}),
    });
  },

  // Move the existing envelope in place so its FIFO position and replay identity
  // survive owner cancellation. A detached child is reparented exactly once by
  // its task-generation lifecycle guard; this method never clones notifications.
  reparent(predicate: (item: EmitItem) => boolean, ownerId: string | undefined): number {
    const target: EmitItem["target"] =
      ownerId !== undefined && activeOwners.has(ownerId) ? "inventory" : "both";
    let changed = 0;
    for (const klass of PRIORITY_ORDER) {
      for (const item of subQueues[klass]) {
        if (!predicate(item)) continue;
        if (ownerId === undefined) delete item.ownerId;
        else item.ownerId = ownerId;
        item.target = target;
        changed += 1;
      }
    }
    if (changed > 0) syncStateSnapshot();
    return changed;
  },

  peek(filter?: { class?: EmitClass; ownerId?: string }): readonly EmitItem[] {
    const out: EmitItem[] = [];
    for (const klass of PRIORITY_ORDER) {
      if (filter?.class !== undefined && filter.class !== klass) continue;
      for (const item of subQueues[klass]) {
        if (filter?.ownerId !== undefined && item.ownerId !== filter.ownerId) continue;
        out.push(item);
      }
    }
    return out;
  },

  // Owner-scoped consumption of inventory items: a fork drains completions
  // addressed to it at its own loop boundary — the counterpart of the main
  // loop's drainForBoundary, which never picks inventory targets.
  takeForOwner(ownerId: string): EmitItem[] {
    const taken: EmitItem[] = [];
    const consumedIds = new Set<string>();
    for (const klass of PRIORITY_ORDER) {
      for (const item of subQueues[klass]) {
        if (item.ownerId !== ownerId) continue;
        if (item.target !== "inventory") continue;
        taken.push(item);
        consumedIds.add(item.id);
      }
    }
    const replayKeys = taken.flatMap((item) =>
      item.replayKey === undefined ? [] : [item.replayKey],
    );
    commitDrain(consumedIds, false);
    ownerLifecycleCallbacks.get(ownerId)?.onInventoryConsumed?.(replayKeys);
    if (consumedIds.size > 0) syncStateSnapshot();
    return taken;
  },

  waitForOwner(ownerId: string, signal?: AbortSignal): Promise<void> {
    if (hasOwnerInventory(ownerId) || signal?.aborted === true) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let unsubscribe = (): void => {};
      const finish = (): void => {
        unsubscribe();
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      unsubscribe = stateStore.subscribe(() => {
        if (hasOwnerInventory(ownerId)) finish();
      });
      signal?.addEventListener("abort", finish, { once: true });
      if (hasOwnerInventory(ownerId) || signal?.aborted === true) finish();
    });
  },

  drainForBoundary(boundary: EmitBoundary): DrainResult {
    const plan = planDrain(boundary);
    if (plan.picked.length === 0) {
      return {
        llmBlocks: [],
        transcriptEntries: [],
        consumedIds: [],
        notificationTexts: [],
      };
    }
    const projected = projectDrain(plan.picked, boundary);
    const awaiterDelivered = tryDeliverToAwaitersForDrain(plan.picked);
    commitDrain(plan.consumedIds);
    const stopHookActive = plan.picked.some((item) => item.stopHookActive === true);
    const result: DrainResult = {
      llmBlocks: projected.llmBlocks,
      transcriptEntries: projected.transcriptEntries,
      consumedIds: Array.from(plan.consumedIds).filter((id) => !awaiterDelivered.has(id)),
      notificationTexts: projected.notificationTexts,
      ...(stopHookActive ? { stopHookActive: true } : {}),
    };
    fireNotificationHooksForDrain(plan.picked);
    for (const listener of drainListeners) {
      try {
        listener(result, boundary);
      } catch {}
    }
    return result;
  },

  awaitFirst(
    filter: { class: EmitClass; ownerId?: string },
    signal?: AbortSignal,
  ): Promise<EmitItem> {
    return new Promise<EmitItem>((resolve, reject) => {
      const entry: AwaiterEntry = { filter, resolve, reject };
      awaiters.push(entry);
      if (signal !== undefined) {
        const onAbort = (): void => {
          const idx = awaiters.indexOf(entry);
          if (idx >= 0) awaiters.splice(idx, 1);
          reject(new Error("aborted"));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  },

  cancel(predicate: (item: EmitItem) => boolean, _reason: string): CancelResult {
    const cancelledIds: string[] = [];
    const classCounts = emptySizes();
    for (const klass of PRIORITY_ORDER) {
      const queue = subQueues[klass];
      if (queue.length === 0) continue;
      const next: EmitItem[] = [];
      for (const item of queue) {
        if (predicate(item)) {
          cancelledIds.push(item.id);
          classCounts[klass] += 1;
          continue;
        }
        next.push(item);
      }
      queue.length = 0;
      for (const item of next) queue.push(item);
    }
    if (cancelledIds.length > 0) syncStateSnapshot();
    return { cancelledIds, classCounts };
  },

  setTurnActive(active: boolean): DrainResult | null {
    if (turnActive === active) {
      if (active) consumedStickyKeys.clear();
      return null;
    }
    turnActive = active;
    if (active) consumedStickyKeys.clear();
    syncStateSnapshot();
    if (active) return emitQueue.drainForBoundary("turn_start");
    return null;
  },

  hasPendingAutoTurn(): boolean {
    return stateStore.getState().hasPendingAutoTurn;
  },

  isTurnActive(): boolean {
    return turnActive;
  },

  wasReplayKeyConsumed(replayKey: string): boolean {
    return consumedReplayKeys.has(replayKey);
  },

  subscribe(listener: (state: PriorityStateSnapshot) => void): () => void {
    return stateStore.subscribe(() => listener(stateStore.getState()));
  },

  onDrain(listener: (result: DrainResult, boundary: EmitBoundary) => void): () => void {
    drainListeners.add(listener);
    return () => {
      drainListeners.delete(listener);
    };
  },

  getState(): PriorityStateSnapshot {
    return stateStore.getState();
  },

  _setNotificationHookRunnerForTests(runner: NotificationHookRunner | null): void {
    notificationHookRunner = runner ?? defaultNotificationHookRunner;
  },

  _resetForTests(): void {
    for (const klass of PRIORITY_ORDER) subQueues[klass].length = 0;
    consumedStickyKeys.clear();
    consumedReplayKeys.clear();
    activeOwners.clear();
    ownerLifecycleCallbacks.clear();
    awaiters.length = 0;
    drainListeners.clear();
    turnActive = false;
    idCounter = 0;
    notificationHookRunner = defaultNotificationHookRunner;
    syncStateSnapshot();
  },
};

export { BOUNDARY_POLICY, PRIORITY_ORDER } from "@/engine/queue/priority.ts";
