import { randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  type ActiveWorktreeSessionEntry,
  loadConfigSync,
  projectConfigKey,
  type UserConfig,
  updateConfig,
} from "@/kernel/config/config.ts";
import { fireWorktreeCreateHooks, fireWorktreeRemoveHooks } from "@/kernel/hooks/handler.ts";
import { canonicalizeCwd } from "@/kernel/std/fs/paths.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import type { SessionRecord } from "./record/schema.ts";
import type { Session } from "./record/state.ts";

/**
 * Session-scoped worktree state (EnterWorktree/ExitWorktree foundation).
 * Distinct from Agent-isolation worktrees under `otherside/agent/*`, which
 * overlay dirty files and only auto-remove pristine trees.
 */
export type SessionWorktreeState = {
  /** Directory active immediately before the first EnterWorktree call. */
  originalCwd: string;
  /** Project anchor from before any worktree relocation, retained across switches. */
  preEnterOriginalCwd?: string;
  activePath: string;
  /** User-facing worktree slug (unflattened), when this session created/reused it. */
  worktreeName?: string;
  managedBranch?: string;
  baseSha?: string;
  ownerRepoRoot?: string;
  nestedRepoRoot?: string;
  hookBased?: boolean;
  lockReason?: string;
  resumedExisting?: boolean;
  resetToFreshBase?: boolean;
  ownership: "created" | "enteredExisting";
  tmuxSession?: string;
};

const liveHosts = new Map<string, Session>();
/** Per-subagent/fork controllers — never mutate the parent session cwd. */
const subagentControllers = new Map<string, SessionWorktreeState>();

const SESSION_BRANCH_PREFIX = "worktree-";
const SESSION_BASELINE_FILENAME = "otherside-session-baseline";
const SESSION_LOCK_PREFIX = "otherside session";

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

function latchWorktreeName(state: SessionWorktreeState): void {
  if (state.ownership !== "created") return;
  if (state.worktreeName !== undefined && state.worktreeName.length > 0) {
    lastCreatedWorktreeName = state.worktreeName;
  }
}

/**
 * PR reference forms accepted by `--worktree`: a pull-request URL
 * (`https://host/owner/repo/pull/123`) or a bare `#123`. Returns the PR
 * number, or null when the value is a plain worktree name.
 */
export function parsePRReference(raw: string): number | null {
  const url = raw.match(/^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)\/?(?:[?#].*)?$/i);
  if (url?.[1]) return Number.parseInt(url[1], 10);
  const short = raw.match(/^#(\d+)$/);
  if (short?.[1]) return Number.parseInt(short[1], 10);
  return null;
}

/** Companion tmux session name for a worktree launch: `<repo>_worktree-<name>`. */
export function worktreeTmuxSessionName(repoRoot: string, name: string): string {
  return `${basename(repoRoot)}_${SESSION_BRANCH_PREFIX}${flattenWorktreeName(name)}`.replace(
    /[/.]/g,
    "_",
  );
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

export async function enterSessionWorktree(
  ctx: RequestContext,
  opts: { name?: string; path?: string; prNumber?: number; tmuxSessionName?: string },
): Promise<{ worktreePath: string; worktreeBranch?: string; message: string }> {
  const existing = getActiveWorktree(ctx);
  const pathInput = typeof opts.path === "string" && opts.path.length > 0 ? opts.path : undefined;
  if (existing !== null && pathInput === undefined) {
    throw new Error(
      "Already in a worktree session. Pass `path` to switch into another existing worktree, or use ExitWorktree to leave this one before creating a new worktree.",
    );
  }

  const originalCwd = existing?.originalCwd ?? ctx.cwd;
  const preEnterOriginalCwd =
    existing?.preEnterOriginalCwd ?? ctx.originalCwd ?? resolveStorageCwd(ctx);

  if (pathInput !== undefined) {
    // Agents may only switch between managed worktrees. The main session pins
    // the managed-location rule to targets already under the managed root;
    // an external target instead goes through the permission ask gate.
    const requireManagedLocation = isAgentContext(ctx)
      ? true
      : (await resolveManagedSessionWorktreePath(ctx.cwd, pathInput)) !== null;
    const target = await resolveExistingWorktreeTarget(ctx.cwd, pathInput, {
      requireManagedLocation,
      requireCwdInsideRepo: isPinnedCwdContext(ctx),
    });
    if (existing !== null && !existing.hookBased && existing.ownership === "created") {
      await releaseSessionWorktreeLock(existing);
    }
    const state: SessionWorktreeState = {
      originalCwd,
      preEnterOriginalCwd,
      activePath: target.worktreePath,
      worktreeName: basename(target.worktreePath),
      ownership: "enteredExisting",
      ownerRepoRoot: target.ownerRepoRoot,
      ...(target.nestedRepoRoot !== undefined ? { nestedRepoRoot: target.nestedRepoRoot } : {}),
      ...(target.worktreeBranch !== undefined ? { managedBranch: target.worktreeBranch } : {}),
    };
    applyEnter(ctx, state);
    await finalizeMainSessionEnter(ctx, state);
    const branchInfo = target.worktreeBranch ? ` on branch ${target.worktreeBranch}` : "";
    const message = isPinnedCwdContext(ctx)
      ? `Entered worktree at ${target.worktreePath}${branchInfo}. This agent's working directory and write access now point at the worktree; the previous directory was left untouched.`
      : `Entered worktree at ${target.worktreePath}${branchInfo}. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`;
    return {
      worktreePath: target.worktreePath,
      ...(target.worktreeBranch !== undefined ? { worktreeBranch: target.worktreeBranch } : {}),
      message,
    };
  }

  // Creation is a main-session capability: every agent works in a directory
  // the caller chose for it, so an agent may only switch into an existing
  // managed worktree, never mint a new one.
  if (isAgentContext(ctx)) {
    throw new Error(
      "EnterWorktree cannot create a worktree from a subagent. To switch this agent into an existing managed worktree (under .otherside/worktrees/ of this repository), call EnterWorktree with `path`. To work in any other directory, spawn an Agent with `cwd` set to it.",
    );
  }

  const name = opts.name ?? autoWorktreeName();
  validateWorktreeSlug(name);
  const config = loadConfigSync();
  const hookPath = await firstNonemptyHookPath(config, name);
  if (hookPath !== null) {
    const resolved = resolve(ctx.cwd, hookPath);
    if (!(await pathExists(resolved))) {
      throw new Error(`WorktreeCreate hook returned a path that does not exist: ${resolved}`);
    }
    const branch = await currentBranch(resolved);
    const head = await revParse(resolved, "HEAD");
    const state: SessionWorktreeState = {
      originalCwd,
      preEnterOriginalCwd,
      activePath: resolved,
      worktreeName: name,
      ownership: "created",
      hookBased: true,
      ...(opts.tmuxSessionName !== undefined ? { tmuxSession: opts.tmuxSessionName } : {}),
      ...(branch !== null ? { managedBranch: branch } : {}),
      ...(head !== null ? { baseSha: head } : {}),
    };
    applyEnter(ctx, state);
    await finalizeMainSessionEnter(ctx, state);
    const branchInfo = branch ? ` on branch ${branch}` : "";
    return {
      worktreePath: resolved,
      ...(branch !== null ? { worktreeBranch: branch } : {}),
      message: `Created worktree at ${resolved}${branchInfo}. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`,
    };
  }

  const repoRoot = await canonicalGitRoot(ctx.cwd);
  if (repoRoot === null) {
    throw new Error(
      "Cannot create a worktree: not in a git repository and no WorktreeCreate hooks are configured. Configure WorktreeCreate/WorktreeRemove hooks in settings.json to use worktree isolation with other VCS systems.",
    );
  }
  const flattened = flattenWorktreeName(name);
  const managedPath = join(repoRoot, ".otherside", "worktrees", flattened);
  const managedBranch = `${SESSION_BRANCH_PREFIX}${flattened}`;

  if (await pathExists(managedPath)) {
    await assertRegisteredWorktree(repoRoot, managedPath);
    const branch = await currentBranch(managedPath);
    if (branch !== managedBranch && (branch === null || !isSessionManagedBranch(branch))) {
      throw new Error(
        `worktree "${name}" already exists at ${managedPath} but is not on a managed worktree branch`,
      );
    }
    const resumedBranch = branch ?? managedBranch;
    const head = await revParse(managedPath, "HEAD");
    const rawBaseline = await readSessionBaseline(managedPath);
    // A pristine worktree whose work is already merged into the remote default
    // is reset to the current base instead of resumed on stale history. A
    // PR-reference reuse is always resumed as-is.
    const freshBase =
      opts.prNumber !== undefined || (config.worktree?.baseRef ?? "fresh") === "head"
        ? null
        : await resetReusedWorktreeToFreshBase(repoRoot, managedPath, managedBranch, {
            headSha: head,
            baselineSha: rawBaseline,
          });
    const baseline = freshBase ?? rawBaseline ?? head;
    const lock = await acquireSessionWorktreeLock(managedPath, repoRoot, ctx.sessionId);
    const state: SessionWorktreeState = {
      originalCwd,
      preEnterOriginalCwd,
      activePath: managedPath,
      worktreeName: name,
      managedBranch: resumedBranch,
      ownerRepoRoot: repoRoot,
      resumedExisting: true,
      ...(freshBase !== null ? { resetToFreshBase: true } : {}),
      ownership: lock.owned ? "created" : "enteredExisting",
      ...(opts.tmuxSessionName !== undefined ? { tmuxSession: opts.tmuxSessionName } : {}),
      ...(baseline !== null ? { baseSha: baseline } : {}),
      ...(lock.reason !== undefined ? { lockReason: lock.reason } : {}),
    };
    applyEnter(ctx, state);
    await finalizeMainSessionEnter(ctx, state);
    const preamble =
      freshBase !== null
        ? `Reused worktree at ${managedPath} on branch ${resumedBranch}. A worktree with this name already existed; its previous work was fully merged upstream, so it was reset to the current base.`
        : `Resumed worktree at ${managedPath} on branch ${resumedBranch}. A worktree with this name already existed and was resumed as-is — it may carry an earlier session’s commits. Pass a different name if you wanted a fresh worktree.`;
    return {
      worktreePath: managedPath,
      worktreeBranch: resumedBranch,
      message: `${preamble} The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`,
    };
  }

  const baseSha =
    opts.prNumber !== undefined
      ? await resolvePrBaseSha(repoRoot, opts.prNumber)
      : await resolveFreshBaseSha(repoRoot, config, ctx.cwd);

  await mkdir(dirname(managedPath), { recursive: true });
  const sparsePaths = config.worktree?.sparsePaths ?? [];
  const addArgs = ["worktree", "add"];
  if (sparsePaths.length > 0) addArgs.push("--no-checkout");
  addArgs.push("--no-track", "-B", managedBranch, managedPath, baseSha);
  const added = await git(repoRoot, addArgs);
  if (!added.ok) {
    await rm(managedPath, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Failed to create worktree at ${managedPath}`);
  }
  if (sparsePaths.length > 0) {
    await configureSparseCheckout(repoRoot, managedPath, sparsePaths);
  }
  await prepareCreatedWorktree(repoRoot, managedPath, config);
  await writeSessionBaseline(managedPath, baseSha);
  const lock = await acquireSessionWorktreeLock(managedPath, repoRoot, ctx.sessionId);
  const state: SessionWorktreeState = {
    originalCwd,
    preEnterOriginalCwd,
    activePath: managedPath,
    worktreeName: name,
    managedBranch,
    baseSha,
    ownerRepoRoot: repoRoot,
    ownership: lock.owned ? "created" : "enteredExisting",
    ...(opts.tmuxSessionName !== undefined ? { tmuxSession: opts.tmuxSessionName } : {}),
    ...(lock.reason !== undefined ? { lockReason: lock.reason } : {}),
  };
  applyEnter(ctx, state);
  await finalizeMainSessionEnter(ctx, state);
  return {
    worktreePath: managedPath,
    worktreeBranch: managedBranch,
    message: `Created worktree at ${managedPath} on branch ${managedBranch}. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`,
  };
}

export async function exitSessionWorktree(
  ctx: RequestContext,
  opts: {
    action: "keep" | "remove";
    discardChanges?: boolean;
    /**
     * Cwd recovery when the original directory is gone: the tool path falls
     * back worktree → home → tmp; the session-end path climbs the original
     * directory's parent chain instead.
     */
    restoreStrategy?: "tool" | "parent-chain";
  },
): Promise<{
  action: "keep" | "remove";
  originalCwd: string;
  restoredCwd: string;
  worktreePath?: string;
  worktreeBranch?: string;
  discardedFiles?: number;
  discardedCommits?: number;
  message: string;
}> {
  // Exit is a main-session capability: an agent never relocates the session
  // it belongs to, even when it owns the controller that entered the worktree.
  if (isAgentContext(ctx)) {
    throw new Error(
      "ExitWorktree cannot be called from a subagent — this agent is already isolated; use Bash with `cd` for directory changes within it.",
    );
  }
  const active = getActiveWorktree(ctx);
  if (active === null) throw new Error("Not in a worktree session");

  const originalCwd = active.originalCwd;
  const worktreePath = active.activePath;
  const worktreeBranch = active.managedBranch;

  const restore =
    opts.restoreStrategy === "parent-chain"
      ? (from: string) => climbToExistingDirectory(from)
      : (from: string) => restoreAfterWorktreeExit(from, worktreePath);

  const restoreStrategy = opts.restoreStrategy === "parent-chain" ? "parent-chain" : "tool";

  if (opts.action === "keep") {
    await releaseSessionWorktreeLock(active);
    const restoredCwd = await restore(originalCwd);
    clearActive(ctx);
    setActiveCwd(ctx, restoredCwd, null);
    await finalizeMainSessionExit(ctx, active, restoredCwd, restoreStrategy);
    return {
      action: "keep",
      originalCwd,
      restoredCwd,
      worktreePath,
      ...(worktreeBranch !== undefined ? { worktreeBranch } : {}),
      message: `Left worktree at ${worktreePath} (kept on disk); cwd restored to ${restoredCwd}`,
    };
  }

  if (active.ownership === "enteredExisting") {
    throw new Error(`This session does not own the worktree at ${worktreePath}`);
  }

  // A remove attempt — successful or not — stops advertising the worktree in
  // the exit resume hint; only kept worktrees remain suggested.
  clearLatchedWorktreeName();

  const discard = opts.discardChanges === true;
  const dirty = await countDirtyPaths(worktreePath, active.baseSha);
  if (!discard && (dirty.files > 0 || dirty.commitsAhead > 0 || dirty.gitError)) {
    throw new Error(
      `${worktreePath} has local changes or could not be verified; pass discardChanges to force remove`,
    );
  }

  let removed = false;
  if (active.hookBased) {
    try {
      await fireWorktreeRemoveHooks(loadConfigSync(), worktreePath);
      removed = !(await pathExists(worktreePath));
    } catch {
      removed = false;
    }
  } else {
    const repoRoot =
      active.ownerRepoRoot ??
      (await canonicalGitRoot(originalCwd)) ??
      (await canonicalGitRoot(worktreePath));
    if (repoRoot !== null && (await mayRemoveSessionWorktree(active, repoRoot))) {
      await git(repoRoot, ["worktree", "unlock", worktreePath]);
      const result = await git(repoRoot, ["worktree", "remove", "--force", worktreePath]);
      removed = result.ok || !(await pathExists(worktreePath));
      if (removed && worktreeBranch !== undefined && isSessionManagedBranch(worktreeBranch)) {
        await git(repoRoot, ["branch", "-D", worktreeBranch]);
      }
    }
  }

  const restoredCwd = await restore(originalCwd);
  clearActive(ctx);
  setActiveCwd(ctx, restoredCwd, null);
  await finalizeMainSessionExit(ctx, active, restoredCwd, restoreStrategy);

  if (!removed) {
    return {
      action: "keep",
      originalCwd,
      restoredCwd,
      worktreePath,
      ...(worktreeBranch !== undefined ? { worktreeBranch } : {}),
      discardedFiles: 0,
      discardedCommits: 0,
      message: `Worktree cleanup failed; kept at ${worktreePath}`,
    };
  }

  return {
    action: "remove",
    originalCwd,
    restoredCwd,
    worktreePath,
    ...(worktreeBranch !== undefined ? { worktreeBranch } : {}),
    discardedFiles: dirty.files,
    discardedCommits: dirty.commitsAhead,
    message: `Removed worktree at ${worktreePath}; cwd restored to ${restoredCwd}`,
  };
}

/**
 * On resume: restore the recorded worktree by state alone — the directory's
 * existence is the only gate, and no git process runs. A missing directory
 * clears the recorded state (stamp + slot) and the session stays at its
 * storage home (re-homed when that died with the worktree), with a
 * non-destructive warning.
 */
export async function restoreSessionWorktreeOnResume(
  session: Session,
  recorded: SessionWorktreeState | null | undefined,
): Promise<{ restored: boolean; warning?: string }> {
  attachSessionWorktreeHost(session);
  if (recorded === null || recorded === undefined) {
    session.worktree = null;
    session.cwd = session.storageCwd;
    return { restored: false };
  }

  const active = resolve(recorded.activePath);
  if (!(await pathExists(active))) {
    const home = await settleFailedRestoreHome(session, recorded);
    await clearProjectWorktreeSlot(session.id);
    return {
      restored: false,
      warning: `session worktree: ${active} no longer exists; staying at ${home}`,
    };
  }

  session.worktree = {
    ...recorded,
    activePath: active,
    originalCwd: recorded.originalCwd || session.storageCwd,
  };
  session.cwd = active;
  latchWorktreeName(session.worktree);
  // Re-persist (stamp + slot): the restored state is re-recorded as current.
  await persistProjectWorktreeSlot(session.worktree, session.id);
  return { restored: true };
}

/**
 * Latest worktree stamp in a loaded transcript, scanned from the tail.
 * `stamped: false` means the transcript predates stamps (callers fall back to
 * the project-config slot); a `state: null` stamp is an explicit exit.
 */
export function stampedWorktreeStateFrom(
  records: readonly SessionRecord[],
): { stamped: true; state: SessionWorktreeState | null } | { stamped: false } {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record?.type !== "worktree_state") continue;
    return { stamped: true, state: worktreeStateFromUnknown(record.state) };
  }
  return { stamped: false };
}

// ── project-config persistence ────────────────────────────────────────────
//
// The active worktree session is persisted as a single slot on the project
// entry of the user config (`projects[<repo root>].activeWorktreeSession`),
// written when a session enters a worktree, cleared when it exits, and read
// back on resume. The transcript itself carries no worktree state.

/** Project anchor for the slot: the repository root, else the original cwd. */
async function projectAnchorFor(state: SessionWorktreeState): Promise<string> {
  if (state.ownerRepoRoot !== undefined) return state.ownerRepoRoot;
  const root = await canonicalGitRoot(state.preEnterOriginalCwd ?? state.originalCwd);
  return root ?? resolve(state.preEnterOriginalCwd ?? state.originalCwd);
}

function slotFromState(state: SessionWorktreeState, sessionId: string): ActiveWorktreeSessionEntry {
  return { sessionId, ...state };
}

/**
 * Runtime shape gate for worktree state read back from persisted sources
 * (transcript stamp, project-config slot) — both are external inputs on
 * resume, so one validator owns the contract.
 */
function worktreeStateFromUnknown(value: unknown): SessionWorktreeState | null {
  if (value === null || typeof value !== "object") return null;
  const state = value as Record<string, unknown>;
  if (typeof state.activePath !== "string" || state.activePath.length === 0) return null;
  if (typeof state.originalCwd !== "string" || state.originalCwd.length === 0) return null;
  if (state.ownership !== "created" && state.ownership !== "enteredExisting") return null;
  return state as unknown as SessionWorktreeState;
}

function stateFromSlot(slot: ActiveWorktreeSessionEntry): SessionWorktreeState | null {
  const { sessionId: _sessionId, ...state } = slot;
  return worktreeStateFromUnknown(state);
}

/**
 * Transcript stamp for the session's current worktree state (best-effort):
 * every persisted state change is also recorded in the transcript, and the
 * latest stamp is what resume restores from.
 */
async function stampWorktreeState(
  sessionId: string,
  state: SessionWorktreeState | null,
): Promise<void> {
  const host = liveHosts.get(sessionId);
  if (host === undefined) return;
  try {
    const { appendRecord } = await import("./append.ts");
    const { nowIso } = await import("./record/schema.ts");
    await appendRecord(host, {
      type: "worktree_state",
      ts: nowIso(),
      sessionId,
      state: state === null ? null : ({ ...state } as unknown as Record<string, unknown>),
    });
  } catch {
    // Best-effort: an unwritable transcript must not break worktree flow.
  }
}

/** Persist the active worktree state (transcript stamp + project slot). */
export async function persistProjectWorktreeSlot(
  state: SessionWorktreeState,
  sessionId: string,
): Promise<void> {
  await stampWorktreeState(sessionId, state);
  const key = projectConfigKey(await projectAnchorFor(state));
  try {
    await updateConfig((cfg) => {
      cfg.projects ??= {};
      // A session holds at most one slot; drop stale slots under other keys.
      for (const [existingKey, entry] of Object.entries(cfg.projects)) {
        if (existingKey !== key && entry?.activeWorktreeSession?.sessionId === sessionId) {
          delete entry.activeWorktreeSession;
        }
      }
      cfg.projects[key] = {
        ...cfg.projects[key],
        activeWorktreeSession: slotFromState(state, sessionId),
      };
    });
  } catch {
    // Best-effort: an unwritable config must not break worktree entry.
  }
}

/**
 * Clear the persisted worktree state for this session (best-effort): a null
 * transcript stamp records the exit, and every owned project slot is removed.
 */
export async function clearProjectWorktreeSlot(sessionId: string): Promise<void> {
  await stampWorktreeState(sessionId, null);
  try {
    const cfg = loadConfigSync();
    const owned = Object.values(cfg.projects ?? {}).some(
      (entry) => entry?.activeWorktreeSession?.sessionId === sessionId,
    );
    if (!owned) return;
    await updateConfig((mutable) => {
      for (const entry of Object.values(mutable.projects ?? {})) {
        if (entry?.activeWorktreeSession?.sessionId === sessionId) {
          delete entry.activeWorktreeSession;
        }
      }
    });
  } catch {
    // Best-effort: an unwritable config must not break worktree exit.
  }
}

/** Read the persisted worktree slot for this session, if any. */
export function readProjectWorktreeSlot(sessionId: string): SessionWorktreeState | null {
  try {
    const cfg = loadConfigSync();
    for (const entry of Object.values(cfg.projects ?? {})) {
      const slot = entry?.activeWorktreeSession;
      if (slot !== undefined && slot.sessionId === sessionId) return stateFromSlot(slot);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Launch-time base directory for `--worktree`: a session started inside a
 * linked worktree anchors on the main repository root instead (matching the
 * launch flag semantics of resolving to the main checkout); a non-repo cwd is
 * reported so the caller can gate the flag.
 */
export async function resolveWorktreeLaunchBase(
  cwd: string,
): Promise<{ baseCwd: string; gitRepo: boolean }> {
  const root = await canonicalGitRoot(cwd);
  if (root === null) return { baseCwd: cwd, gitRepo: false };
  const gitDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const commonDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const linked =
    gitDir.ok &&
    commonDir.ok &&
    gitDir.stdout.trim().length > 0 &&
    !samePath(gitDir.stdout.trim(), commonDir.stdout.trim());
  return { baseCwd: linked ? root : cwd, gitRepo: true };
}

export function flattenWorktreeName(name: string): string {
  return name.replaceAll("/", "+");
}

export function isSessionManagedBranch(branch: string): boolean {
  return branch.startsWith(SESSION_BRANCH_PREFIX);
}

// ── internal ──────────────────────────────────────────────────────────────

function subagentControllerKey(ctx: RequestContext): string | null {
  const owner =
    typeof ctx.agentId === "string" && ctx.agentId.length > 0
      ? ctx.agentId
      : typeof ctx.agentOwnerId === "string" && ctx.agentOwnerId.length > 0
        ? ctx.agentOwnerId
        : null;
  if (owner === null) return null;
  return `${ctx.sessionId}::${owner}`;
}

function resolveStorageCwd(ctx: RequestContext): string {
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
 * Post-enter bookkeeping for the main session (subagent controllers skip it):
 * the transcript follows the active worktree so resume from inside the
 * worktree finds the session, and the project-config slot records the active
 * worktree session. Hook-based and foreign-repo targets keep the original
 * transcript home.
 */
async function finalizeMainSessionEnter(
  ctx: RequestContext,
  state: SessionWorktreeState,
): Promise<void> {
  if (subagentControllerKey(ctx) !== null) return;
  if (!state.hookBased && state.nestedRepoRoot === undefined) {
    await relocateHostTranscript(ctx.sessionId, state.activePath);
  }
  await persistProjectWorktreeSlot(state, ctx.sessionId);
}

/**
 * Post-exit bookkeeping for the main session: the project-config slot is
 * cleared, and the transcript is relocated back to the pre-enter project
 * anchor — but only when the original directory was actually restored. The
 * tool-exit fallback that lands back inside the worktree keeps the transcript
 * with it; a parent-chain fallback (session end) leaves the transcript where
 * it is.
 */
async function finalizeMainSessionExit(
  ctx: RequestContext,
  active: SessionWorktreeState,
  restoredCwd: string,
  strategy: "tool" | "parent-chain",
): Promise<void> {
  if (subagentControllerKey(ctx) !== null) return;
  await clearProjectWorktreeSlot(ctx.sessionId);
  // Restore paths come back realpath'd; canonicalize both sides so a
  // symlinked original directory still counts as restored.
  const restoredToOriginal = samePath(
    canonicalizeCwd(restoredCwd),
    canonicalizeCwd(active.originalCwd),
  );
  if (restoredToOriginal) {
    await relocateHostTranscript(ctx.sessionId, active.preEnterOriginalCwd ?? restoredCwd);
    return;
  }
  if (
    strategy === "tool" &&
    samePath(canonicalizeCwd(restoredCwd), canonicalizeCwd(active.activePath))
  ) {
    await relocateHostTranscript(ctx.sessionId, restoredCwd);
  }
}

/**
 * Landing spot after a failed worktree restore. Normally the session's
 * storage home; when that home died with the worktree (the transcript was
 * relocated into it on enter), the pre-enter anchor — or the nearest live
 * ancestor — takes over and the transcript moves back with it.
 */
async function settleFailedRestoreHome(
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
async function relocateHostTranscript(sessionId: string, newCwd: string): Promise<void> {
  const host = liveHosts.get(sessionId);
  if (host === undefined) return;
  try {
    const { relocateSessionTranscript } = await import("./relocate-cwd.ts");
    await relocateSessionTranscript(host, newCwd);
  } catch {
    // Best-effort: the session keeps working from its previous storage home.
  }
}

function applyEnter(ctx: RequestContext, state: SessionWorktreeState): void {
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

function clearActive(ctx: RequestContext): void {
  const subKey = subagentControllerKey(ctx);
  if (subKey !== null) {
    subagentControllers.delete(subKey);
    return;
  }
  const host = liveHosts.get(ctx.sessionId);
  if (host) host.worktree = null;
}

function setActiveCwd(ctx: RequestContext, cwd: string, worktreeRoot: string | null): void {
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

function validateWorktreeSlug(name: string): void {
  if (name.length > 64) {
    throw new Error(`Invalid worktree name: must be 64 characters or fewer (got ${name.length})`);
  }
  for (const segment of name.split("/")) {
    if (segment === "." || segment === "..") {
      throw new Error(
        `Invalid worktree name "${name}": must not contain "." or ".." path segments`,
      );
    }
    if (segment.toLowerCase().replace(/\.+$/, "") === ".git") {
      throw new Error(
        `Invalid worktree name "${name}": "${segment}" is a reserved git directory name`,
      );
    }
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) {
      throw new Error(
        `Invalid worktree name "${name}": each "/"-separated segment must be non-empty and contain only letters, digits, dots, underscores, and dashes`,
      );
    }
  }
}

function autoWorktreeName(): string {
  return `session-${randomUUID().slice(0, 8)}`;
}

async function firstNonemptyHookPath(config: UserConfig, name: string): Promise<string | null> {
  const outcomes = await fireWorktreeCreateHooks(config, name);
  if (outcomes.length === 0) return null;
  for (const outcome of outcomes) {
    if (outcome.kind !== "ok") continue;
    for (const line of outcome.stdout.split("\n")) {
      const path = line.trim();
      if (path.length > 0) return path;
    }
  }
  const failure = outcomes.find((outcome) => outcome.kind !== "ok");
  if (failure !== undefined) {
    throw new Error(`WorktreeCreate hook failed: ${failure.kind}`);
  }
  throw new Error("WorktreeCreate hook did not return a worktree path");
}

// FETCH_HEAD older than this triggers a bounded background refresh of the
// default branch before basing a fresh worktree on it.
const FRESH_BASE_FETCH_STALENESS_MS = 86_400_000;
const FRESH_BASE_FETCH_TIMEOUT_MS = 5_000;

async function defaultBranchName(repoRoot: string): Promise<string | null> {
  const originHead = await git(repoRoot, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  if (originHead.ok) {
    const ref = originHead.stdout.trim();
    if (ref.startsWith("origin/") && ref !== "origin/HEAD") return ref.slice("origin/".length);
  }
  for (const candidate of ["main", "master"]) {
    if ((await revParse(repoRoot, `origin/${candidate}`)) !== null) return candidate;
  }
  return null;
}

async function fetchHeadAgeMs(repoRoot: string): Promise<number> {
  const gitDir = await git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!gitDir.ok) return Number.POSITIVE_INFINITY;
  try {
    const at = (await stat(join(gitDir.stdout.trim(), "FETCH_HEAD"))).mtimeMs;
    return Date.now() - at;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** PR-reference base: fetch `pull/<N>/head` from origin and pin FETCH_HEAD. */
async function resolvePrBaseSha(repoRoot: string, prNumber: number): Promise<string> {
  const fetched = await git(repoRoot, ["fetch", "origin", `pull/${prNumber}/head`]);
  if (!fetched.ok) {
    throw new Error(
      `Failed to fetch PR #${prNumber}: PR may not exist or the repository may not have a remote named "origin"`,
    );
  }
  const sha = await revParse(repoRoot, "FETCH_HEAD");
  if (sha === null)
    throw new Error(`Failed to resolve base branch "FETCH_HEAD": git rev-parse failed`);
  return sha;
}

/**
 * Fresh mode bases the worktree on origin/<default>: an already-known remote
 * ref is used as-is (with a bounded refresh when FETCH_HEAD is stale), an
 * unknown one is fetched once, and HEAD is the fallback when the remote is
 * unreachable. Head mode resolves HEAD in the launch directory.
 */
async function resolveFreshBaseSha(
  repoRoot: string,
  config: UserConfig,
  fromCwd: string,
): Promise<string> {
  const setting = config.worktree?.baseRef ?? "fresh";
  if (setting === "head") {
    const head = await revParse(fromCwd, "HEAD");
    if (head === null) throw new Error(`Could not resolve HEAD in ${fromCwd}`);
    return head;
  }
  const branch = await defaultBranchName(repoRoot);
  if (branch === null) {
    const head = await revParse(repoRoot, "HEAD");
    if (head === null) throw new Error("Could not resolve worktree base ref HEAD");
    return head;
  }
  const remoteRef = `origin/${branch}`;
  let sha = await revParse(repoRoot, remoteRef);
  if (sha !== null) {
    if ((await fetchHeadAgeMs(repoRoot)) > FRESH_BASE_FETCH_STALENESS_MS) {
      const fetched = await git(repoRoot, ["fetch", "origin", branch], {
        timeoutMs: FRESH_BASE_FETCH_TIMEOUT_MS,
      });
      if (fetched.ok) sha = (await revParse(repoRoot, remoteRef)) ?? sha;
    }
    return sha;
  }
  const fetched = await git(repoRoot, ["fetch", "origin", branch]);
  const ref = fetched.ok ? remoteRef : "HEAD";
  const resolved = await revParse(repoRoot, ref);
  if (resolved === null) throw new Error(`Could not resolve worktree base ref ${ref}`);
  return resolved;
}

/**
 * Reset a reused managed worktree to the current remote-default base when it
 * is safe: the tree is pristine, sits on its managed branch, and its HEAD is
 * either the recorded baseline or fully merged into the remote default.
 * Returns the new base sha, or null when any gate fails (resume as-is).
 */
async function resetReusedWorktreeToFreshBase(
  repoRoot: string,
  worktreePath: string,
  expectedBranch: string,
  shas: { headSha: string | null; baselineSha: string | null },
): Promise<string | null> {
  const branch = await defaultBranchName(repoRoot);
  if (branch === null || branch.startsWith("-")) return null;
  const freshSha = await revParse(repoRoot, `origin/${branch}`);
  if (freshSha === null || freshSha === shas.headSha) return null;

  const current = await currentBranch(worktreePath);
  if (current !== expectedBranch) return null;

  const status = await git(worktreePath, ["--no-optional-locks", "status", "--porcelain"]);
  if (!status.ok || status.stdout.trim().length > 0) return null;

  const atBaseline = shas.baselineSha !== null && shas.headSha === shas.baselineSha;
  if (!atBaseline) {
    const remoteRef = await defaultRemoteRef(repoRoot);
    if (remoteRef === null || !(await allCommitsMergedInto(worktreePath, remoteRef))) return null;
  }

  try {
    const lockReason = await lockReasonFor(worktreePath, repoRoot);
    if (lockReason !== undefined && isLiveForeignSessionLock(lockReason)) return null;
  } catch {
    return null;
  }

  const reset = await git(worktreePath, ["reset", "--hard", freshSha]);
  if (!reset.ok) return null;
  await writeSessionBaseline(worktreePath, freshSha);
  return freshSha;
}

/** Short remote-default ref (`origin/<branch>`) resolved from origin/HEAD or common defaults. */
async function defaultRemoteRef(cwd: string): Promise<string | null> {
  const head = await git(cwd, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok && head.stdout.trim().length > 0) return head.stdout.trim();
  for (const candidate of ["origin/main", "origin/master"]) {
    if ((await revParse(cwd, candidate)) !== null) return candidate;
  }
  return null;
}

/**
 * True when the checked-out branch's upstream is gone and every HEAD commit
 * has an equivalent in `remoteRef` (cherry-pick equivalence, merges ignored).
 */
async function allCommitsMergedInto(worktreePath: string, remoteRef: string): Promise<boolean> {
  const headRef = await git(worktreePath, ["symbolic-ref", "-q", "HEAD"]);
  const fullRef = headRef.stdout.trim();
  if (!headRef.ok || fullRef.length === 0) return false;
  const track = await git(worktreePath, [
    "for-each-ref",
    "--format=%(upstream:track,nobracket)",
    fullRef,
  ]);
  if (!track.ok || track.stdout.trim() !== "gone") return false;
  const unmerged = await git(worktreePath, [
    "rev-list",
    "--cherry-pick",
    "--right-only",
    "--no-merges",
    "--max-count=1",
    `${remoteRef}...HEAD`,
  ]);
  return unmerged.ok && unmerged.stdout.trim().length === 0;
}

async function configureSparseCheckout(
  repoRoot: string,
  worktreePath: string,
  sparsePaths: string[],
): Promise<void> {
  const fail = async (message: string): Promise<never> => {
    await git(repoRoot, ["worktree", "remove", "--force", worktreePath]);
    await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
    throw new Error(message);
  };
  const existing = await git(repoRoot, ["config", "--local", "--get", "extensions.worktreeConfig"]);
  if (!existing.ok) {
    const set = await git(repoRoot, ["config", "--local", "extensions.worktreeConfig", "true"]);
    if (!set.ok) await fail("Failed to enable the worktree config extension for sparse checkout");
  }
  const sparse = await git(worktreePath, [
    "sparse-checkout",
    "set",
    "--cone",
    "--",
    ...sparsePaths,
  ]);
  if (!sparse.ok) await fail("Failed to configure sparse-checkout");
  const checkout = await git(worktreePath, ["checkout", "HEAD"]);
  if (!checkout.ok) await fail("Failed to checkout sparse worktree");
}

/**
 * One-time setup for a freshly created worktree: project-local settings copy,
 * hooks-path forwarding to the main checkout, and configured directory
 * symlinks. Every step is best-effort and guarded against destinations that
 * escape the worktree through committed symlinks.
 */
async function prepareCreatedWorktree(
  repoRoot: string,
  worktreePath: string,
  config: UserConfig,
): Promise<void> {
  const worktreeReal = await realpath(worktreePath).catch(() => null);
  if (worktreeReal === null) return;
  await copyLocalSettingsIntoWorktree(repoRoot, worktreePath, worktreeReal);
  await forwardHooksPath(repoRoot, worktreePath);
  const symlinkDirs = config.worktree?.symlinkDirectories ?? [];
  if (symlinkDirs.length > 0) {
    await symlinkWorktreeDirectories(repoRoot, worktreePath, worktreeReal, symlinkDirs);
  }
  await copyWorktreeIncludeFiles(repoRoot, worktreePath, worktreeReal);
}

/**
 * Copy git-ignored files matching the repo's `.worktreeinclude` patterns
 * (gitignore syntax) into a fresh worktree — ignored files never arrive via
 * checkout, so env-style local files are propagated here. Ignored directories
 * are only expanded when a pattern plausibly targets them. Symlink sources and
 * destinations that escape the worktree are skipped. Best-effort throughout.
 */
async function copyWorktreeIncludeFiles(
  repoRoot: string,
  worktreePath: string,
  worktreeReal: string,
): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(join(repoRoot, ".worktreeinclude"), "utf8");
  } catch {
    return [];
  }
  const patterns = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (patterns.length === 0) return [];

  const listed = await git(repoRoot, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  if (!listed.ok || listed.stdout.trim().length === 0) return [];
  const entries = listed.stdout.split("\n").filter((line) => line.length > 0);
  const files = entries.filter((entry) => !entry.endsWith("/"));
  const dirs = entries.filter((entry) => entry.endsWith("/"));

  const matcher = await gitignoreMatcher(patterns, [
    ...files,
    ...dirs.map((dir) => dir.slice(0, -1)),
  ]);
  const selected = files.filter((file) => matcher.has(file));

  const expandDirs = dirs.filter((dir) => {
    if (
      patterns.some((pattern) => {
        const cleaned = pattern.startsWith("/") ? pattern.slice(1) : pattern;
        if (cleaned.startsWith(dir)) return true;
        const wildcardAt = cleaned.search(/[*?[]/);
        return wildcardAt > 0 && dir.startsWith(cleaned.slice(0, wildcardAt));
      })
    ) {
      return true;
    }
    return matcher.has(dir.slice(0, -1));
  });
  if (expandDirs.length > 0) {
    const expanded = await git(repoRoot, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--",
      ...expandDirs,
    ]);
    if (expanded.ok && expanded.stdout.trim().length > 0) {
      const expandedFiles = expanded.stdout.split("\n").filter((line) => line.length > 0);
      const expandedMatch = await gitignoreMatcher(patterns, expandedFiles);
      for (const file of expandedFiles) {
        if (expandedMatch.has(file)) selected.push(file);
      }
    }
  }

  const copied: string[] = [];
  for (const relative of selected) {
    const source = join(repoRoot, relative);
    const destination = join(worktreePath, relative);
    try {
      if ((await lstat(source)).isSymbolicLink()) continue;
      if (await writeDestEscapesWorktree(destination, worktreeReal)) continue;
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      copied.push(relative);
    } catch {
      // best-effort propagation; the worktree still works without the file
    }
  }
  return copied;
}

/**
 * Match relative paths against gitignore-syntax patterns with git's own
 * matcher: a throwaway repo carries the patterns as its exclude file and
 * `check-ignore` reports which candidates match.
 */
async function gitignoreMatcher(patterns: string[], candidates: string[]): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const { mkdtemp, rm: rmDir } = await import("node:fs/promises");
  let scratch: string | null = null;
  try {
    scratch = await mkdtemp(join(tmpdir(), "otherside-wt-include-"));
    const init = await git(scratch, ["init", "-q"]);
    if (!init.ok) return new Set();
    await mkdir(join(scratch, ".git", "info"), { recursive: true });
    await writeFile(join(scratch, ".git", "info", "exclude"), `${patterns.join("\n")}\n`, "utf8");
    const proc = Bun.spawn(["git", "-C", scratch, "check-ignore", "--stdin"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    proc.stdin.write(`${candidates.join("\n")}\n`);
    await proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return new Set(stdout.split("\n").filter((line) => line.length > 0));
  } catch {
    return new Set();
  } finally {
    if (scratch !== null) await rmDir(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

async function copyLocalSettingsIntoWorktree(
  repoRoot: string,
  worktreePath: string,
  worktreeReal: string,
): Promise<void> {
  const relative = join(".otherside", "settings.local.json");
  const source = join(repoRoot, relative);
  try {
    if ((await lstat(source)).isSymbolicLink()) return;
  } catch {
    return;
  }
  const destination = join(worktreePath, relative);
  if (await writeDestEscapesWorktree(destination, worktreeReal)) return;
  try {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  } catch {
    // best-effort propagation; the worktree still works without local settings
  }
}

async function forwardHooksPath(repoRoot: string, worktreePath: string): Promise<void> {
  const configured = await git(repoRoot, ["config", "--get", "core.hooksPath"]);
  if (!configured.ok) return;
  const raw = configured.stdout.trim();
  if (raw.length === 0 || isAbsolute(raw)) return;
  // A relative hooks path resolves against each checkout; forwarding the
  // absolute main-checkout location keeps the same hooks running in the
  // worktree.
  const absolute = resolve(repoRoot, raw);
  await git(worktreePath, ["config", "core.hooksPath", absolute]);
}

async function symlinkWorktreeDirectories(
  repoRoot: string,
  worktreePath: string,
  worktreeReal: string,
  entries: string[],
): Promise<void> {
  for (const entry of entries) {
    if (isAbsolute(entry) || entry.split(/[/\\]/).some((segment) => /^\.\.[ .]*$/.test(segment))) {
      continue;
    }
    const source = join(repoRoot, entry);
    const destination = join(worktreePath, entry);
    try {
      await lstat(source);
    } catch {
      continue;
    }
    if (await writeDestEscapesWorktree(destination, worktreeReal)) continue;
    try {
      await symlink(source, destination, "dir");
    } catch {
      // ENOENT/EEXIST are expected when the tree already carries the entry
    }
  }
}

/**
 * True when writing at `destination` would land outside the worktree — the
 * nearest existing ancestor must realpath-resolve inside it and the
 * destination itself must not be a symlink.
 */
async function writeDestEscapesWorktree(
  destination: string,
  worktreeReal: string,
): Promise<boolean> {
  let dir = dirname(destination);
  for (;;) {
    try {
      const real = await realpath(dir);
      if (!samePath(real, worktreeReal) && !pathInside(real, worktreeReal)) return true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
      const exists = await lstat(dir).then(
        () => true,
        (e) => (e as NodeJS.ErrnoException).code !== "ENOENT",
      );
      if (exists) return true;
      const parent = dirname(dir);
      if (parent === dir) return true;
      dir = parent;
    }
  }
  try {
    if ((await lstat(destination)).isSymbolicLink()) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
  }
  return false;
}

interface RegisteredWorktree {
  worktreePath: string;
  worktreeBranch?: string;
  lockReason?: string;
  prunable?: boolean;
}

async function listRegisteredWorktrees(repoRoot: string): Promise<RegisteredWorktree[]> {
  const listed = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!listed.ok) throw new Error(`git worktree list failed for ${repoRoot}`);
  const entries: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | null = null;
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current !== null) entries.push(current);
      current = { worktreePath: line.slice("worktree ".length) };
    } else if (current !== null && line.startsWith("branch ")) {
      current.worktreeBranch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (current !== null && (line === "locked" || line.startsWith("locked "))) {
      current.lockReason = line.slice("locked".length).trim();
    } else if (current !== null && (line === "prunable" || line.startsWith("prunable "))) {
      current.prunable = true;
    }
  }
  if (current !== null) entries.push(current);
  return entries;
}

async function assertRegisteredWorktree(repoRoot: string, path: string): Promise<void> {
  const registered = await listRegisteredWorktrees(repoRoot);
  if (!registered.some((entry) => samePath(entry.worktreePath, path))) {
    throw new Error(`${path} is not a registered worktree of ${repoRoot}`);
  }
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" || process.platform === "darwin"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function pathInside(path: string, root: string): boolean {
  if (samePath(path, root)) return true;
  const candidate = resolve(path);
  const parent = resolve(root);
  return process.platform === "win32" || process.platform === "darwin"
    ? candidate.toLowerCase().startsWith(`${parent.toLowerCase()}${sep}`)
    : candidate.startsWith(`${parent}${sep}`);
}

function isNetworkWorktreePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    normalized.startsWith("//") ||
    normalized === "/net" ||
    normalized.startsWith("/net/") ||
    normalized === "/Network" ||
    normalized.startsWith("/Network/")
  );
}

export async function resolveManagedSessionWorktreePath(
  cwd: string,
  path: string,
): Promise<string | null> {
  try {
    if (isNetworkWorktreePath(path)) return null;
    const repoRoot = await canonicalGitRoot(cwd);
    if (repoRoot === null) return null;
    const targetReal = await realpath(resolve(cwd, path));
    const rootReal = await realpath(repoRoot);
    const managedPath = join(rootReal, ".otherside", "worktrees");
    const managedReal = await realpath(managedPath);
    if (!samePath(managedPath, managedReal) || !pathInside(targetReal, managedReal)) return null;
    return targetReal;
  } catch {
    return null;
  }
}

async function resolveExistingWorktreeTarget(
  cwd: string,
  path: string,
  options: { requireManagedLocation: boolean; requireCwdInsideRepo: boolean },
): Promise<{
  worktreePath: string;
  worktreeBranch?: string;
  ownerRepoRoot: string;
  nestedRepoRoot?: string;
}> {
  if (isNetworkWorktreePath(path) || isNetworkWorktreePath(resolve(cwd, path))) {
    throw new Error(`Cannot enter worktree: ${path} is a network path.`);
  }
  const sourceRepoRoot = await canonicalGitRoot(cwd);
  if (sourceRepoRoot === null) {
    throw new Error(
      "Cannot enter an existing worktree: the current directory is not in a git repository.",
    );
  }

  let targetReal: string;
  let sourceRootReal: string;
  let sourceCwdReal: string;
  try {
    [targetReal, sourceRootReal, sourceCwdReal] = await Promise.all([
      realpath(resolve(cwd, path)),
      realpath(sourceRepoRoot),
      realpath(cwd),
    ]);
  } catch (error) {
    throw new Error(
      `Cannot enter worktree: ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (samePath(targetReal, sourceRootReal)) {
    throw new Error(
      `Cannot enter worktree: ${path} is the main working tree, not a linked worktree.`,
    );
  }
  if (samePath(targetReal, sourceCwdReal)) {
    throw new Error(`Cannot enter worktree: ${path} is the current working directory.`);
  }
  if (options.requireCwdInsideRepo && !pathInside(sourceCwdReal, sourceRootReal)) {
    throw new Error(
      `Cannot enter worktree: the current working directory ${cwd} is not inside the repository at ${sourceRepoRoot}.`,
    );
  }

  if (options.requireManagedLocation) {
    const managed = await resolveManagedSessionWorktreePath(cwd, path);
    if (managed === null || !samePath(managed, targetReal)) {
      throw new Error(
        `Cannot enter worktree: ${path} is not under ${join(sourceRootReal, ".otherside", "worktrees")}. Switching from this session is limited to worktrees managed by Otherside.`,
      );
    }
  }

  const targetRepoRoot = await canonicalGitRoot(targetReal);
  if (targetRepoRoot === null) {
    throw new Error(`Cannot enter worktree: ${path} is not in a git repository.`);
  }
  const ownerRepoRoot = await realpath(targetRepoRoot);
  const nested = !samePath(ownerRepoRoot, sourceRootReal);
  if (nested && (options.requireManagedLocation || !pathInside(ownerRepoRoot, sourceCwdReal))) {
    throw new Error(
      `Cannot enter worktree: ${path} belongs to repository ${ownerRepoRoot}, not ${sourceRepoRoot}.`,
    );
  }

  const registered = await listRegisteredWorktrees(ownerRepoRoot);
  const entry = registered.find((candidate) => samePath(candidate.worktreePath, targetReal));
  if (entry === undefined) {
    throw new Error(
      `Cannot enter worktree: ${path} is not a registered worktree of ${ownerRepoRoot}.`,
    );
  }
  if (entry.prunable) {
    throw new Error(`Cannot enter worktree: ${path} is marked prunable by git.`);
  }
  if (entry.lockReason !== undefined && isLiveForeignSessionLock(entry.lockReason)) {
    throw new Error(
      `Cannot enter worktree: ${path} belongs to another running Otherside session (locked: ${entry.lockReason}).`,
    );
  }

  return {
    worktreePath: targetReal,
    ownerRepoRoot,
    ...(entry.worktreeBranch !== undefined ? { worktreeBranch: entry.worktreeBranch } : {}),
    ...(nested ? { nestedRepoRoot: ownerRepoRoot } : {}),
  };
}

function sessionLockReason(sessionId: string): string {
  return `${SESSION_LOCK_PREFIX} ${sessionId} (pid ${process.pid})`;
}

function lockPid(reason: string): number | null {
  const raw = /\bpid (\d+)\b/.exec(reason)?.[1];
  if (raw === undefined) return null;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isLiveForeignSessionLock(reason: string): boolean {
  if (!reason.startsWith(SESSION_LOCK_PREFIX)) return true;
  const pid = lockPid(reason);
  return pid !== null && pid !== process.pid && processIsRunning(pid);
}

async function lockReasonFor(path: string, repoRoot: string): Promise<string | undefined> {
  const registered = await listRegisteredWorktrees(repoRoot);
  return registered.find((entry) => samePath(entry.worktreePath, path))?.lockReason;
}

async function acquireSessionWorktreeLock(
  path: string,
  repoRoot: string,
  sessionId: string,
): Promise<{ owned: boolean; reason?: string }> {
  const wanted = sessionLockReason(sessionId);
  let current = await lockReasonFor(path, repoRoot);
  if (current === wanted) return { owned: true, reason: wanted };
  if (current !== undefined) {
    if (isLiveForeignSessionLock(current)) return { owned: false, reason: current };
    const pid = lockPid(current);
    if (!current.startsWith(SESSION_LOCK_PREFIX) || (pid !== null && processIsRunning(pid))) {
      return { owned: false, reason: current };
    }
    await git(repoRoot, ["worktree", "unlock", path]);
  }
  const locked = await git(repoRoot, ["worktree", "lock", "--reason", wanted, path]);
  if (!locked.ok) {
    current = await lockReasonFor(path, repoRoot).catch(() => undefined);
    return current === undefined ? { owned: false } : { owned: false, reason: current };
  }
  return { owned: true, reason: wanted };
}

async function releaseSessionWorktreeLock(active: SessionWorktreeState): Promise<void> {
  if (
    active.hookBased ||
    active.ownership !== "created" ||
    active.ownerRepoRoot === undefined ||
    active.lockReason === undefined
  ) {
    return;
  }
  const current = await lockReasonFor(active.activePath, active.ownerRepoRoot).catch(
    () => undefined,
  );
  if (current === active.lockReason && lockPid(current) === process.pid) {
    await git(active.ownerRepoRoot, ["worktree", "unlock", active.activePath]);
  }
}

async function mayRemoveSessionWorktree(
  active: SessionWorktreeState,
  repoRoot: string,
): Promise<boolean> {
  if (active.ownership !== "created" || active.lockReason === undefined) return false;
  try {
    const current = await lockReasonFor(active.activePath, repoRoot);
    return current === active.lockReason && lockPid(current) === process.pid;
  } catch {
    return false;
  }
}

async function privateGitDir(path: string): Promise<string | null> {
  const result = await git(path, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const gitDir = result.stdout.trim();
  return result.ok && gitDir.length > 0 ? gitDir : null;
}

async function writeSessionBaseline(path: string, sha: string): Promise<void> {
  const gitDir = await privateGitDir(path);
  if (gitDir === null) return;
  await writeFile(join(gitDir, SESSION_BASELINE_FILENAME), sha, "utf8").catch(() => {});
}

async function readSessionBaseline(path: string): Promise<string | null> {
  const gitDir = await privateGitDir(path);
  if (gitDir === null) return null;
  try {
    const sha = (await readFile(join(gitDir, SESSION_BASELINE_FILENAME), "utf8")).trim();
    return /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Session-end recovery: walk up the original directory's parent chain and
 * land on the nearest ancestor that still exists.
 */
async function climbToExistingDirectory(originalCwd: string): Promise<string> {
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

async function restoreAfterWorktreeExit(
  originalCwd: string,
  worktreePath: string,
): Promise<string> {
  const candidates = [
    originalCwd,
    worktreePath,
    homedir(),
    process.env.OTHERSIDE_TMPDIR ?? process.env.CLAUDE_CODE_TMPDIR ?? tmpdir(),
  ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isDirectory()) return await realpath(candidate);
    } catch {}
  }
  return originalCwd;
}

async function countDirtyPaths(
  path: string,
  baseSha: string | undefined,
): Promise<{ files: number; commitsAhead: number; gitError: boolean }> {
  const status = await git(path, ["status", "--porcelain"]);
  if (!status.ok) return { files: 0, commitsAhead: 0, gitError: true };
  const files = status.stdout.split("\n").filter((line) => line.trim().length > 0).length;
  if (baseSha === undefined) return { files, commitsAhead: 0, gitError: true };
  const ahead = await git(path, ["rev-list", "--count", `${baseSha}..HEAD`]);
  if (!ahead.ok) return { files, commitsAhead: 0, gitError: true };
  const commitsAhead = Number.parseInt(ahead.stdout.trim(), 10) || 0;
  return { files, commitsAhead, gitError: false };
}

async function currentBranch(cwd: string): Promise<string | null> {
  const r = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!r.ok) return null;
  const b = r.stdout.trim();
  return b.length > 0 ? b : null;
}

async function revParse(cwd: string, ref: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", ref]);
  if (!r.ok) return null;
  const sha = r.stdout.trim();
  return sha.length > 0 ? sha : null;
}

async function canonicalGitRoot(cwd: string): Promise<string | null> {
  const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) return null;
  const dir = common.stdout.trim();
  return dir.length > 0 ? dirname(dir) : null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function git(
  cwd: string,
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer =
      opts?.timeoutMs !== undefined
        ? setTimeout(() => {
            proc.kill();
          }, opts.timeoutMs)
        : null;
    timer?.unref?.();
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (timer !== null) clearTimeout(timer);
    return { ok: code === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}
