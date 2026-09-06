import { realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import type { Session } from "./record/state.ts";
import { pathExists, samePath } from "./worktree-path.ts";
import type { SessionWorktreeState } from "./worktree-state.ts";

const liveHosts = new Map<string, Session>();
/** Per-subagent/fork controllers — never mutate the parent session cwd. */
const subagentControllers = new Map<string, SessionWorktreeState>();

/**
 * Worktree name to advertise in the exit resume hint: the active created
 * worktree's name while one is live, else the last created one — kept worktrees
 * stay advertised, removed ones are cleared.
 */
let lastCreatedWorktreeName: string | null = null;

export function latchedWorktreeName(): string | null {
  return lastCreatedWorktreeName;
}

export function clearLatchedWorktreeName(): void {
  lastCreatedWorktreeName = null;
}

export function latchWorktreeName(state: SessionWorktreeState): void {
  if (state.ownership !== "created") return;
  if (state.worktreeName !== undefined && state.worktreeName.length > 0) {
    lastCreatedWorktreeName = state.worktreeName;
  }
}

export function attachSessionWorktreeHost(session: Session): void {
  liveHosts.set(session.id, session);
}

export function detachSessionWorktreeHost(sessionId: string): void {
  liveHosts.delete(sessionId);
  const prefix = `${sessionId}::`;
  for (const key of subagentControllers.keys()) {
    if (key.startsWith(prefix)) subagentControllers.delete(key);
  }
}

export function getActiveWorktree(ctx: RequestContext): SessionWorktreeState | null {
  const subKey = subagentControllerKey(ctx);
  if (subKey !== null) return subagentControllers.get(subKey) ?? null;
  const host = liveHosts.get(ctx.sessionId);
  return host?.worktree ?? null;
}

export function subagentControllerKey(ctx: RequestContext): string | null {
  const owner =
    typeof ctx.agentId === "string" && ctx.agentId.length > 0
      ? ctx.agentId
      : typeof ctx.agentOwnerId === "string" && ctx.agentOwnerId.length > 0
        ? ctx.agentOwnerId
        : null;
  if (owner === null) return null;
  return `${ctx.sessionId}::${owner}`;
}

export function resolveStorageCwd(ctx: RequestContext): string {
  const host = liveHosts.get(ctx.sessionId);
  if (host) return host.storageCwd;
  return ctx.originalCwd ?? ctx.cwd;
}

export function isPinnedCwdContext(ctx: RequestContext): boolean {
  return (
    subagentControllerKey(ctx) !== null &&
    ctx.worktreeRoot !== undefined &&
    ctx.originalCwd !== undefined &&
    !samePath(ctx.cwd, ctx.originalCwd)
  );
}

/** Any agent/fork/child context — creation and exit are main-session only. */
export function isAgentContext(ctx: RequestContext): boolean {
  return (
    subagentControllerKey(ctx) !== null ||
    (typeof ctx.agentOwnerId === "string" && ctx.agentOwnerId.length > 0) ||
    (typeof ctx.parentThreadId === "string" && ctx.parentThreadId.length > 0)
  );
}

/**
 * Landing spot after a failed worktree restore. Normally the session's
 * storage home; when that home died with the worktree (the transcript was
 * relocated into it on enter), the pre-enter anchor — or the nearest live
 * ancestor — takes over and the transcript moves back with it.
 */
export async function settleFailedRestoreHome(
  session: Session,
  recorded: SessionWorktreeState,
): Promise<string> {
  session.worktree = null;
  clearLatchedWorktreeName();
  if (await pathExists(session.storageCwd)) {
    session.cwd = session.storageCwd;
    return session.storageCwd;
  }
  let home: string | null = null;
  for (const candidate of [recorded.preEnterOriginalCwd, recorded.originalCwd]) {
    if (candidate !== undefined && candidate.length > 0 && (await pathExists(candidate))) {
      home = candidate;
      break;
    }
  }
  home ??= await climbToExistingDirectory(session.storageCwd);
  await relocateHostTranscript(session.id, home);
  session.cwd = home;
  return home;
}

/** Move the live session's transcript storage to `newCwd` (best-effort). */
export async function relocateHostTranscript(sessionId: string, newCwd: string): Promise<void> {
  const host = liveHosts.get(sessionId);
  if (host === undefined) return;
  try {
    const { moveSessionTranscript } = await import("./relocate-cwd.ts");
    await moveSessionTranscript(host, newCwd);
  } catch {
    // Best-effort: the session keeps working from its previous storage home.
  }
}

export function applyEnter(ctx: RequestContext, state: SessionWorktreeState): void {
  const subKey = subagentControllerKey(ctx);
  if (subKey !== null) {
    subagentControllers.set(subKey, state);
    ctx.originalCwd = ctx.originalCwd ?? state.originalCwd;
    ctx.cwd = state.activePath;
    ctx.worktreeRoot = state.activePath;
    return;
  }
  const host = liveHosts.get(ctx.sessionId);
  if (host) {
    host.worktree = state;
    host.cwd = state.activePath;
  }
  latchWorktreeName(state);
  ctx.originalCwd = state.originalCwd;
  ctx.cwd = state.activePath;
  ctx.worktreeRoot = state.activePath;
}

export function clearActive(ctx: RequestContext): void {
  const subKey = subagentControllerKey(ctx);
  if (subKey !== null) {
    subagentControllers.delete(subKey);
    return;
  }
  const host = liveHosts.get(ctx.sessionId);
  if (host) host.worktree = null;
}

export function setActiveCwd(ctx: RequestContext, cwd: string, worktreeRoot: string | null): void {
  ctx.cwd = cwd;
  if (worktreeRoot === null) {
    delete ctx.worktreeRoot;
  } else {
    ctx.worktreeRoot = worktreeRoot;
  }
  const subKey = subagentControllerKey(ctx);
  if (subKey !== null) return;
  const host = liveHosts.get(ctx.sessionId);
  if (host) host.cwd = cwd;
}

/**
 * Session-end recovery: walk up the original directory's parent chain and
 * land on the nearest ancestor that still exists.
 */
export async function climbToExistingDirectory(originalCwd: string): Promise<string> {
  let candidate = originalCwd;
  for (;;) {
    try {
      if ((await stat(candidate)).isDirectory()) return await realpath(candidate);
    } catch {}
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
}

export function sessionWorktreeHost(sessionId: string): Session | undefined {
  return liveHosts.get(sessionId);
}
