import { existsSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { forkSpecPathForCwd, forkStopPathForCwd } from "@/engine/session/paths.ts";
import { atomicWriteFileSync, mkdirSecure } from "@/kernel/std/fs/secure-fs.ts";
import { EFFORT_LEVEL_VALUES, type EffortLevel } from "@/kernel/std/types/effort.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import { PERMISSION_MODES, type PermissionMode } from "@/kernel/std/types/permission-mode.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";
import type { ForkSpec } from "./types.ts";

export interface DurableForkSpecV1 {
  version: 1;
  forkId: string;
  kind: "fork" | "subagent";
  agentId: string;
  /** Legacy display label carried by older specs; read tolerantly, never written. */
  name?: string;
  prompt: string;
  body?: string;
  description?: string;
  // The spawn-time value is retained for diagnostics and definition-pinned
  // children. Inherited children must instead resolve the caller's live mode
  // when they resume.
  permissionMode: PermissionMode;
  permissionModeIsDefinitionPinned?: boolean;
  effort: EffortLevel | null;
  cwd: string;
  originalCwd?: string;
  worktreeRoot?: string;
  isolation?: "worktree";
  provider: string;
  model: string;
  sessionId: string;
  parentToolCallId?: string;
  allowSet: string[] | null;
  deferredAllow?: string[];
  initialMessages?: Message[];
}

export interface DurableForkSpecRef {
  cwd: string;
  sessionId: string;
  forkId: string;
}

const DURABLE_FORK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isDurableForkId(value: string): boolean {
  return DURABLE_FORK_ID_PATTERN.test(value);
}

export function markDurableForkStopped(ref: DurableForkSpecRef): void {
  if (!isDurableForkId(ref.forkId)) throw new Error(`invalid durable fork id: ${ref.forkId}`);
  const path = forkStopPathForCwd(ref.cwd, ref.sessionId, ref.forkId);
  mkdirSecure(dirname(path), 0o700);
  atomicWriteFileSync(path, "stopped\n", 0o600);
}

export function isDurableForkStopped(ref: DurableForkSpecRef): boolean {
  if (!isDurableForkId(ref.forkId)) return false;
  return existsSync(forkStopPathForCwd(ref.cwd, ref.sessionId, ref.forkId));
}

export function serializeDurableForkSpec(
  spec: ForkSpec,
  forkId: string,
  ctx: RequestContext,
): DurableForkSpecV1 {
  return {
    version: 1,
    forkId,
    kind: spec.inheritParentTurn === true ? "fork" : "subagent",
    agentId: spec.agentId ?? spec.name,
    prompt: spec.prompt,
    ...(spec.body.length > 0 ? { body: spec.body } : {}),
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    permissionMode: spec.permissionMode ?? ctx.permissionMode,
    permissionModeIsDefinitionPinned: spec.permissionModeIsDefinitionPinned === true,
    effort: ctx.effort,
    cwd: ctx.cwd,
    ...(ctx.originalCwd !== undefined ? { originalCwd: ctx.originalCwd } : {}),
    ...(ctx.worktreeRoot !== undefined ? { worktreeRoot: ctx.worktreeRoot } : {}),
    ...(ctx.worktreeRoot !== undefined || spec.isolation === "worktree"
      ? { isolation: "worktree" as const }
      : {}),
    provider: ctx.provider,
    model: ctx.model,
    sessionId: ctx.sessionId,
    ...(spec.parentToolCallId !== undefined ? { parentToolCallId: spec.parentToolCallId } : {}),
    allowSet: spec.allowSet === null ? null : [...spec.allowSet].sort(),
    ...(spec.deferredAllow !== undefined ? { deferredAllow: [...spec.deferredAllow].sort() } : {}),
    ...(spec.initialMessages !== undefined ? { initialMessages: spec.initialMessages } : {}),
  };
}

export async function writeDurableForkSpec(
  ref: DurableForkSpecRef,
  durable: DurableForkSpecV1,
): Promise<void> {
  if (!isDurableForkId(ref.forkId)) throw new Error(`invalid durable fork id: ${ref.forkId}`);
  if (!durableMatchesRef(durable, ref)) {
    throw new Error(`durable fork spec does not match its storage reference: ${ref.forkId}`);
  }
  const path = forkSpecPathForCwd(ref.cwd, ref.sessionId, ref.forkId);
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporaryPath, JSON.stringify(durable), "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export async function readDurableForkSpec(
  ref: DurableForkSpecRef,
): Promise<DurableForkSpecV1 | null> {
  if (!isDurableForkId(ref.forkId)) return null;
  const file = Bun.file(forkSpecPathForCwd(ref.cwd, ref.sessionId, ref.forkId));
  if (!(await file.exists())) return null;
  try {
    const durable = parseDurableForkSpec(await file.json());
    return durable !== null && durableMatchesRef(durable, ref) ? durable : null;
  } catch {
    return null;
  }
}

function durableMatchesRef(durable: DurableForkSpecV1, ref: DurableForkSpecRef): boolean {
  return (
    durable.forkId === ref.forkId &&
    durable.sessionId === ref.sessionId &&
    (durable.originalCwd ?? durable.cwd) === ref.cwd
  );
}

function parseDurableForkSpec(value: unknown): DurableForkSpecV1 | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (
    typeof value.forkId !== "string" ||
    !isDurableForkId(value.forkId) ||
    (value.kind !== "fork" && value.kind !== "subagent") ||
    typeof value.agentId !== "string" ||
    !isOptionalString(value.name) ||
    typeof value.prompt !== "string" ||
    typeof value.cwd !== "string" ||
    typeof value.provider !== "string" ||
    typeof value.model !== "string" ||
    typeof value.sessionId !== "string" ||
    !(value.allowSet === null || isStringArray(value.allowSet))
  ) {
    return null;
  }
  if (
    !isPermissionMode(value.permissionMode) ||
    !(
      value.permissionModeIsDefinitionPinned === undefined ||
      typeof value.permissionModeIsDefinitionPinned === "boolean"
    ) ||
    !isEffort(value.effort) ||
    !isOptionalString(value.body) ||
    !isOptionalString(value.description) ||
    !isOptionalString(value.originalCwd) ||
    !isOptionalString(value.worktreeRoot) ||
    !(value.isolation === undefined || value.isolation === "worktree") ||
    !isOptionalString(value.parentToolCallId) ||
    !(value.deferredAllow === undefined || isStringArray(value.deferredAllow)) ||
    !(value.initialMessages === undefined || isMessageArray(value.initialMessages))
  ) {
    return null;
  }
  return value as unknown as DurableForkSpecV1;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isMessageArray(value: unknown): value is Message[] {
  return (
    Array.isArray(value) &&
    value.every(
      (message) =>
        isRecord(message) &&
        (message.role === "system" ||
          message.role === "user" ||
          message.role === "assistant" ||
          message.role === "tool") &&
        Array.isArray(message.content),
    )
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return PERMISSION_MODES.some((mode) => mode === value);
}

function isEffort(value: unknown): value is EffortLevel | null {
  return value === null || EFFORT_LEVEL_VALUES.some((effort) => effort === value);
}
