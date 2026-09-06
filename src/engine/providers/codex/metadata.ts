import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PermissionMode } from "@/kernel/std/types/permission-mode.ts";
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

/** Agent name the main thread reports; nested agents are not named on our wire. */
export const ROOT_AGENT_NAME = "/root";

export interface TurnMetadata {
  installation_id: string;
  session_id: string;
  thread_id: string;
  agent_name: string;
  turn_id: string;
  window_id: string;
  window_number: number;
  context_window_id: string;
  request_kind: RequestKind;
  thread_source: ThreadSource;
  sandbox: string;
  sandbox_mode: SandboxMode;
  auto_review_enabled: boolean;
  node_repl_auto_review_required: boolean;
  node_repl_disabled: boolean;
  turn_started_at_unix_ms?: number;
  workspaces?: Record<string, WorkspaceEntry>;
}

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

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
    agent_name: ROOT_AGENT_NAME,
    turn_id: options.requestKind === "prewarm" || subagent ? "" : identity.turnId,
    window_id: windowId,
    window_number: windowGeneration,
    context_window_id: deriveUuid(windowId, "context-window"),
    request_kind: options.requestKind,
    thread_source: threadSource,
    sandbox: ctx.permissionMode === "yolo" ? "none" : sandboxLabel(),
    sandbox_mode: sandboxMode(ctx.permissionMode),
    auto_review_enabled: false,
    node_repl_auto_review_required: true,
    node_repl_disabled: false,
    ...(options.requestKind === "prewarm"
      ? { workspaces: workspacesForCwd(ctx.cwd) }
      : { turn_started_at_unix_ms: identity.turnStartedAtUnixMs }),
  };
  const turnMetadataHeader = JSON.stringify(turnMetadata);
  const sharedMetadata: Record<string, string> = {
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
    // The upgrade carries hyphenated identity headers and leaves the
    // installation id to turn metadata; the in-frame copy keeps its own keys.
    headerMetadata: { "session-id": sessionId, "thread-id": threadId, ...sharedMetadata },
    clientMetadata: {
      session_id: sessionId,
      "x-codex-installation-id": options.installationId,
      ...sharedMetadata,
    },
  };
}

/** Sandbox policy the turn runs under, derived from the active permission mode. */
function sandboxMode(mode: PermissionMode): SandboxMode {
  switch (mode) {
    case "yolo":
      return "danger-full-access";
    case "plan":
      return "read-only";
    default:
      return "workspace-write";
  }
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
