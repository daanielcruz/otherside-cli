import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { withFileLockSync } from "@/kernel/std/fs/file-lock.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { atomicWriteFileSync, mkdirSecure } from "@/kernel/std/fs/secure-fs.ts";
import { getActiveSessionId, resetTaskOutputPathPins } from "./output-files.ts";

export const TASK_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskRecord {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
  owner?: string | undefined;
  blocks: string[];
  blockedBy: string[];
  metadata: Record<string, unknown>;
}

export type TaskClaimResult =
  | { success: true; task: TaskRecord }
  | { success: false; reason: "task_not_found" }
  | { success: false; reason: "already_resolved"; task: TaskRecord }
  | { success: false; reason: "already_claimed"; task: TaskRecord }
  | { success: false; reason: "blocked"; task: TaskRecord; blockedByTasks: string[] }
  | { success: false; reason: "agent_busy"; task: TaskRecord; busyWithTasks: string[] }
  | { success: false; reason: "claim_failed"; error: string };

export type Scope = string;

const MAIN_SCOPE: Scope = "__leader__";
export const MAIN_TASK_SCOPE: Scope = MAIN_SCOPE;

const stores = new Map<Scope, Map<string, TaskRecord>>();
const counters = new Map<Scope, number>();
const subscribersByScope = new Map<Scope, Set<() => void>>();
// Hydration is keyed by the RESOLVED task-list id, not the scope: the MAIN
// scope follows the active session, so a session rebind (/clear, resume) must
// invalidate what an earlier access hydrated — otherwise a read landing
// between the heap cleanup and the rebind would pin the old session's records
// into the fresh store.
const hydratedListIdByScope = new Map<Scope, string>();

function resolveTaskListId(scope: Scope): string {
  if (scope === MAIN_TASK_SCOPE) {
    return getActiveSessionId() ?? MAIN_TASK_SCOPE;
  }
  return scope;
}

function taskDirectoryFor(taskListId: string): string {
  return join(configRoot(), "tasks", taskListId);
}

function writeTaskFile(scope: Scope, task: TaskRecord): void {
  const taskListId = resolveTaskListId(scope);
  const dir = taskDirectoryFor(taskListId);
  mkdirSecure(dir, 0o755);
  const filePath = join(dir, task.id);
  const content = JSON.stringify(task, null, 2);
  atomicWriteFileSync(filePath, content);
}

function writeHighwatermark(scope: Scope, id: string): void {
  const taskListId = resolveTaskListId(scope);
  const dir = taskDirectoryFor(taskListId);
  mkdirSecure(dir, 0o755);
  const hwmPath = join(dir, ".highwatermark");
  atomicWriteFileSync(hwmPath, id);
}

function deleteTaskFile(scope: Scope, id: string): void {
  const taskListId = resolveTaskListId(scope);
  const dir = taskDirectoryFor(taskListId);
  const filePath = join(dir, id);
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {}
}

function ensureHydrated(scope: Scope): void {
  const taskListId = resolveTaskListId(scope);
  if (hydratedListIdByScope.get(scope) === taskListId) return;
  hydratedListIdByScope.set(scope, taskListId);
  // A list-id change means the previous hydration belongs to another
  // directory; the store is write-through, so dropping it loses nothing.
  storeFor(scope).clear();
  counters.delete(scope);

  const dir = taskDirectoryFor(taskListId);

  if (existsSync(dir)) {
    try {
      const files = readdirSync(dir);
      const store = storeFor(scope);
      let maxId = 0;
      for (const file of files) {
        if (file === ".highwatermark") {
          try {
            const hwmContent = readFileSync(join(dir, file), "utf8").trim();
            const hwm = parseInt(hwmContent, 10);
            if (!Number.isNaN(hwm)) {
              maxId = Math.max(maxId, hwm);
            }
          } catch {}
          continue;
        }

        const filePath = join(dir, file);
        try {
          const content = readFileSync(filePath, "utf8");
          const task = JSON.parse(content) as TaskRecord;
          if (task && typeof task.id === "string") {
            store.set(task.id, task);
            const numericId = parseInt(task.id, 10);
            if (!Number.isNaN(numericId)) {
              maxId = Math.max(maxId, numericId);
            }
          }
        } catch {
          // Tolerate unparseable/missing files on load (skip silently)
        }
      }

      if (maxId > 0) {
        counters.set(scope, maxId + 1);
      }
    } catch {}
  }
}

function storeFor(scope: Scope): Map<string, TaskRecord> {
  let s = stores.get(scope);
  if (!s) {
    s = new Map();
    stores.set(scope, s);
  }
  return s;
}

function subsFor(scope: Scope): Set<() => void> {
  let s = subscribersByScope.get(scope);
  if (!s) {
    s = new Set();
    subscribersByScope.set(scope, s);
  }
  return s;
}

export function subscribe(cb: () => void, scope: Scope = MAIN_SCOPE): () => void {
  const set = subsFor(scope);
  set.add(cb);
  return () => {
    set.delete(cb);
  };
}

export function isHidden(scope: Scope = MAIN_SCOPE): boolean {
  return list(scope).length === 0;
}

function notify(scope: Scope): void {
  const set = subscribersByScope.get(scope);
  if (!set) return;
  for (const cb of set) cb();
}

function nextId(scope: Scope): string {
  const cur = counters.get(scope) ?? 1;
  counters.set(scope, cur + 1);
  return cur.toString();
}

function compareIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
}

export function create(
  input: {
    subject: string;
    description: string;
    activeForm?: string;
    metadata?: Record<string, unknown>;
  },
  scope: Scope = MAIN_SCOPE,
): TaskRecord {
  ensureHydrated(scope);
  const id = nextId(scope);
  const rec: TaskRecord = {
    id,
    subject: input.subject,
    description: input.description,
    ...(input.activeForm !== undefined ? { activeForm: input.activeForm } : {}),
    status: "pending",
    blocks: [],
    blockedBy: [],
    metadata: input.metadata !== undefined ? { ...input.metadata } : {},
  };
  storeFor(scope).set(id, rec);
  writeTaskFile(scope, rec);
  writeHighwatermark(scope, id);
  notify(scope);
  return rec;
}

export function get(id: string, scope: Scope = MAIN_SCOPE): TaskRecord | undefined {
  ensureHydrated(scope);
  return storeFor(scope).get(id);
}

export function list(scope: Scope = MAIN_SCOPE): TaskRecord[] {
  ensureHydrated(scope);
  return [...storeFor(scope).values()].sort((a, b) => compareIds(a.id, b.id));
}

export function block(fromId: string, toId: string, scope: Scope = MAIN_SCOPE): boolean {
  if (fromId === toId) return false;
  ensureHydrated(scope);
  const store = storeFor(scope);
  const from = store.get(fromId);
  const to = store.get(toId);
  if (!from || !to) return false;

  let changed = false;
  if (!from.blocks.includes(toId)) {
    const updatedFrom = { ...from, blocks: [...from.blocks, toId] };
    store.set(fromId, updatedFrom);
    writeTaskFile(scope, updatedFrom);
    changed = true;
  }
  if (!to.blockedBy.includes(fromId)) {
    const updatedTo = { ...to, blockedBy: [...to.blockedBy, fromId] };
    store.set(toId, updatedTo);
    writeTaskFile(scope, updatedTo);
    changed = true;
  }
  if (changed) notify(scope);
  return changed;
}

export function remove(id: string, scope: Scope = MAIN_SCOPE): boolean {
  ensureHydrated(scope);
  const store = storeFor(scope);
  const ok = store.delete(id);
  if (ok) {
    deleteTaskFile(scope, id);
    for (const [otherId, task] of store) {
      const blocks = task.blocks.filter((ref) => ref !== id);
      const blockedBy = task.blockedBy.filter((ref) => ref !== id);
      if (blocks.length !== task.blocks.length || blockedBy.length !== task.blockedBy.length) {
        const updatedTask = { ...task, blocks, blockedBy };
        store.set(otherId, updatedTask);
        writeTaskFile(scope, updatedTask);
      }
    }
    notify(scope);
  }
  return ok;
}

export function updateTaskRecord(
  id: string,
  patch: Partial<Omit<TaskRecord, "id">>,
  scope: Scope = MAIN_SCOPE,
): TaskRecord | undefined {
  ensureHydrated(scope);
  const store = storeFor(scope);
  const cur = store.get(id);
  if (!cur) return undefined;
  const next: TaskRecord = { ...cur, ...patch };
  store.set(id, next);
  writeTaskFile(scope, next);
  notify(scope);
  return next;
}

export function claimTask(id: string, owner: string, scope: Scope = MAIN_SCOPE): TaskClaimResult {
  const taskListId = resolveTaskListId(scope);
  const dir = taskDirectoryFor(taskListId);
  mkdirSecure(dir, 0o755);

  try {
    return withFileLockSync(join(dir, ".claim"), () => {
      // Another process may have changed the list before this lock was acquired.
      // Rehydrate inside the lock so every check and the owner write use one
      // coherent on-disk snapshot.
      hydratedListIdByScope.delete(scope);
      ensureHydrated(scope);

      const store = storeFor(scope);
      const task = store.get(id);
      if (!task) return { success: false, reason: "task_not_found" };
      if (task.status === "completed") {
        return { success: false, reason: "already_resolved", task };
      }
      if (owner === "") {
        const unassigned = updateTaskRecord(id, { owner: undefined }, scope);
        if (!unassigned) return { success: false, reason: "task_not_found" };
        return { success: true, task: unassigned };
      }
      if (task.owner && task.owner === owner) {
        return { success: true, task };
      }
      if (task.owner && task.owner !== owner) {
        return { success: false, reason: "already_claimed", task };
      }

      const activeIds = new Set(
        [...store.values()]
          .filter((candidate) => candidate.status !== "completed")
          .map((candidate) => candidate.id),
      );
      const blockedByTasks = task.blockedBy.filter((blockerId) => activeIds.has(blockerId));
      if (blockedByTasks.length > 0) {
        return { success: false, reason: "blocked", task, blockedByTasks };
      }

      const busyWithTasks = [...store.values()]
        .filter(
          (candidate) =>
            candidate.id !== id && candidate.status !== "completed" && candidate.owner === owner,
        )
        .map((candidate) => candidate.id);
      if (busyWithTasks.length > 0) {
        return { success: false, reason: "agent_busy", task, busyWithTasks };
      }

      const claimed = updateTaskRecord(id, { owner }, scope);
      if (!claimed) return { success: false, reason: "task_not_found" };
      return { success: true, task: claimed };
    });
  } catch (error) {
    return {
      success: false,
      reason: "claim_failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const TASK_STATUS_SET: ReadonlySet<string> = new Set(TASK_STATUSES);

export function isValidStatus(s: string): s is TaskStatus {
  return TASK_STATUS_SET.has(s);
}

// Whole-list cleanup: removes every record but preserves the highwatermark so
// IDs are never reused after the reset.
export function reset(scope: Scope = MAIN_SCOPE): void {
  ensureHydrated(scope);
  const store = storeFor(scope);
  if (store.size === 0) return;
  let maxId = (counters.get(scope) ?? 1) - 1;
  for (const id of store.keys()) {
    const numericId = parseInt(id, 10);
    if (!Number.isNaN(numericId)) maxId = Math.max(maxId, numericId);
  }
  if (maxId > 0) {
    writeHighwatermark(scope, maxId.toString());
    counters.set(scope, maxId + 1);
  }
  for (const id of store.keys()) {
    deleteTaskFile(scope, id);
  }
  store.clear();
  notify(scope);
}

export function clear(scope: Scope = MAIN_SCOPE): void {
  ensureHydrated(scope);
  const store = storeFor(scope);
  const taskListId = resolveTaskListId(scope);
  const dir = taskDirectoryFor(taskListId);

  for (const id of store.keys()) {
    deleteTaskFile(scope, id);
  }

  try {
    const hwmPath = join(dir, ".highwatermark");
    if (existsSync(hwmPath)) {
      unlinkSync(hwmPath);
    }
  } catch {}

  store.clear();
  counters.set(scope, 1);
  notify(scope);
}

export function clearAll(): void {
  stores.clear();
  counters.clear();
  subscribersByScope.clear();
  hydratedListIdByScope.clear();
  resetTaskOutputPathPins();
}

// Heap-state cleanup on session transitions (/clear, fork teardown). Drops
// records and hydration so the next access re-reads the scope's current
// directory — but never the subscribers: those belong to the always-mounted
// UI (process lifetime), and deleting the set would permanently detach the
// all-complete reset watcher after the first /clear. Deliberately silent:
// it runs while the outgoing session id is still bound, and waking
// subscribers here would re-hydrate the old directory into the fresh store.
export function clearScope(scope: Scope): void {
  stores.delete(scope);
  counters.delete(scope);
  hydratedListIdByScope.delete(scope);
}

// Session transitions rebind the MAIN scope to a new directory outside this
// module (setTaskOutputSession); callers wake subscribers afterwards so the
// always-mounted UI re-reads the rebound list instead of rendering the old
// session's records.
export function notifySubscribers(scope: Scope = MAIN_SCOPE): void {
  notify(scope);
}
