import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export type ThreadSource = "user" | "subagent";
export type RequestKind = "prewarm" | "turn";

export interface WorkspaceEntry {
  associated_remote_urls?: { origin?: string };
  latest_git_commit_hash?: string;
  has_changes?: boolean;
}

export interface RequestIdentity {
  fallbackId: string;
  turnId: string;
  forkId: string;
  turnStartedAtUnixMs: number;
}

const REQUEST_IDENTITIES = new WeakMap<object, RequestIdentity>();
const TURN_STARTED_AT = new Map<string, number>();
const MAX_TRACKED_TURN_STARTS = 1_024;

export function requestIdentityForContext(
  ctx: Pick<RequestContext, "turnId" | "agentOwnerId">,
): RequestIdentity {
  let identity = REQUEST_IDENTITIES.get(ctx);
  if (identity === undefined) {
    const fallbackId = crypto.randomUUID();
    identity = {
      fallbackId,
      turnId: ctx.turnId ?? fallbackId,
      forkId: ctx.agentOwnerId ?? fallbackId,
      turnStartedAtUnixMs: turnStartedAtUnixMs(ctx.turnId),
    };
    REQUEST_IDENTITIES.set(ctx, identity);
  }
  return identity;
}

function turnStartedAtUnixMs(turnId: string | undefined): number {
  if (turnId === undefined) return Date.now();
  const existing = TURN_STARTED_AT.get(turnId);
  if (existing !== undefined) return existing;
  const startedAt = Date.now();
  TURN_STARTED_AT.set(turnId, startedAt);
  if (TURN_STARTED_AT.size > MAX_TRACKED_TURN_STARTS) {
    const oldestTurnId = TURN_STARTED_AT.keys().next().value;
    if (oldestTurnId !== undefined) TURN_STARTED_AT.delete(oldestTurnId);
  }
  return startedAt;
}

export interface TurnMetadata {
  installation_id: string;
  session_id: string;
  thread_id: string;
  thread_source: ThreadSource;
  turn_id: string;
  window_id: string;
  sandbox: string;
  request_kind: RequestKind;
  turn_started_at_unix_ms?: number;
  workspaces?: Record<string, WorkspaceEntry>;
}

export interface CodexRequestMetadata {
  installationId: string;
  sessionId: string;
  threadId: string;
  windowId: string;
  windowGeneration: number;
  subagentLabel?: string | undefined;
  turnMetadata: TurnMetadata;
  turnMetadataHeader: string;
  headerMetadata: Record<string, string>;
  clientMetadata: Record<string, string>;
}

export interface CodexRequestMetadataOptions {
  ctx: Pick<
    RequestContext,
    "cwd" | "permissionMode" | "turnId" | "agentOwnerId" | "subagentLabel" | "parentThreadId"
  >;
  installationId: string;
  mainSessionId: string;
  mainThreadId: string;
  windowGeneration: number;
  requestKind: RequestKind;
}

export function buildCodexRequestMetadata(
  options: CodexRequestMetadataOptions,
): CodexRequestMetadata {
  const { ctx } = options;
  const identity = requestIdentityForContext(ctx);
  const subagent = ctx.subagentLabel !== undefined;
  const threadSource: ThreadSource = subagent ? "subagent" : "user";
  const sessionId = subagent
    ? deriveUuid(identity.forkId, "subagent-session")
    : options.mainSessionId;
  const threadId = subagent ? deriveUuid(identity.forkId, "subagent-thread") : options.mainThreadId;
  const windowGeneration = subagent ? 0 : options.windowGeneration;
  const windowId = `${threadId}:${windowGeneration}`;
  const turnMetadata: TurnMetadata = {
    installation_id: options.installationId,
    session_id: sessionId,
    thread_id: threadId,
    thread_source: threadSource,
    turn_id: options.requestKind === "prewarm" || subagent ? "" : identity.turnId,
    window_id: windowId,
    sandbox: ctx.permissionMode === "yolo" ? "none" : sandboxLabel(),
    request_kind: options.requestKind,
    ...(options.requestKind === "prewarm"
      ? { workspaces: workspacesForCwd(ctx.cwd) }
      : { turn_started_at_unix_ms: identity.turnStartedAtUnixMs }),
  };
  const turnMetadataHeader = JSON.stringify(turnMetadata);
  const sharedMetadata: Record<string, string> = {
    "x-codex-installation-id": options.installationId,
    "x-codex-window-id": windowId,
    "x-codex-turn-metadata": turnMetadataHeader,
  };
  if (ctx.subagentLabel) {
    sharedMetadata["x-openai-subagent"] = ctx.subagentLabel;
    if (ctx.parentThreadId) {
      sharedMetadata["x-codex-parent-thread-id"] = ctx.parentThreadId;
    }
  }
  return {
    installationId: options.installationId,
    sessionId,
    threadId,
    windowId,
    windowGeneration,
    ...(ctx.subagentLabel ? { subagentLabel: ctx.subagentLabel } : {}),
    turnMetadata,
    turnMetadataHeader,
    headerMetadata: { session_id: sessionId, ...sharedMetadata },
    clientMetadata: { session_id: sessionId, ...sharedMetadata },
  };
}

function gitCommand(args: string[], cwd: string): string | null {
  try {
    const proc = Bun.spawnSync({
      cmd: ["git", ...args],
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (proc.exitCode !== 0) return null;
    const out = (proc.stdout?.toString?.("utf8") ?? "").trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function workspaceEntryForCwd(cwd: string): WorkspaceEntry | null {
  if (!existsSync(join(cwd, ".git"))) return null;
  const entry: WorkspaceEntry = {};
  const origin = gitCommand(["config", "--get", "remote.origin.url"], cwd);
  if (origin) entry.associated_remote_urls = { origin };
  const commit = gitCommand(["rev-parse", "HEAD"], cwd);
  if (commit) entry.latest_git_commit_hash = commit;
  const status = gitCommand(["status", "--porcelain"], cwd);
  entry.has_changes = status !== null && status.length > 0;
  return entry;
}

function workspacesForCwd(cwd: string): Record<string, WorkspaceEntry> {
  const workspace = workspaceEntryForCwd(cwd);
  return workspace ? { [cwd]: workspace } : {};
}

function sandboxLabel(): string {
  switch (process.platform) {
    case "darwin":
      return "seatbelt";
    case "linux":
      return "landlock";
    default:
      return "none";
  }
}

function deriveUuid(seed: string, salt: string): string {
  const bytes = Buffer.from(
    createHash("sha256").update(`${seed}:${salt}`).digest().subarray(0, 16),
  );
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
