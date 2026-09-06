import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadConfigSync, type UserConfig } from "@/kernel/config/config.ts";
import { fireWorktreeCreateHooks } from "@/kernel/hooks/handler.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  readSessionBaseline,
  resetReusedWorktreeToFreshBase,
  resolveFreshBaseSha,
  resolvePrBaseSha,
  writeSessionBaseline,
} from "./worktree-base.ts";
import { canonicalGitRoot, currentBranch, git, revParse } from "./worktree-git.ts";
import {
  assertValidWorktreeSlug,
  autoWorktreeName,
  flattenWorktreeName,
  isSessionManagedBranch,
  SESSION_BRANCH_PREFIX,
} from "./worktree-naming.ts";
import { pathExists } from "./worktree-path.ts";
import { configureSparseCheckout, prepareCreatedWorktree } from "./worktree-preparation.ts";
import { acquireSessionWorktreeLock, assertRegisteredWorktree } from "./worktree-registry.ts";
import type { SessionWorktreeState } from "./worktree-state.ts";

export interface SessionWorktreeEntry {
  state: SessionWorktreeState;
  result: { worktreePath: string; worktreeBranch?: string; message: string };
}

interface CreateSessionWorktreeOptions {
  ctx: RequestContext;
  originalCwd: string;
  preEnterOriginalCwd: string;
  name?: string;
  prNumber?: number;
  tmuxSessionName?: string;
}

export async function createSessionWorktree(
  options: CreateSessionWorktreeOptions,
): Promise<SessionWorktreeEntry> {
  const name = options.name ?? autoWorktreeName();
  assertValidWorktreeSlug(name);
  const config = loadConfigSync();
  const hookPath = await firstNonemptyHookPath(config, name);
  if (hookPath !== null) return createHookWorktree(options, name, hookPath);

  const repoRoot = await canonicalGitRoot(options.ctx.cwd);
  if (repoRoot === null) {
    throw new Error(
      "Cannot create a worktree: not in a git repository and no WorktreeCreate hooks are configured. Configure WorktreeCreate/WorktreeRemove hooks in settings.json to use worktree isolation with other VCS systems.",
    );
  }
  const flattened = flattenWorktreeName(name);
  const managedPath = join(repoRoot, ".otherside", "worktrees", flattened);
  const managedBranch = `${SESSION_BRANCH_PREFIX}${flattened}`;
  if (await pathExists(managedPath)) {
    return reuseManagedWorktree(options, config, {
      name,
      repoRoot,
      managedPath,
      managedBranch,
    });
  }
  return createManagedWorktree(options, config, { name, repoRoot, managedPath, managedBranch });
}

async function createHookWorktree(
  options: CreateSessionWorktreeOptions,
  name: string,
  hookPath: string,
): Promise<SessionWorktreeEntry> {
  const resolved = resolve(options.ctx.cwd, hookPath);
  if (!(await pathExists(resolved))) {
    throw new Error(`WorktreeCreate hook returned a path that does not exist: ${resolved}`);
  }
  const branch = await currentBranch(resolved);
  const head = await revParse(resolved, "HEAD");
  const state: SessionWorktreeState = {
    originalCwd: options.originalCwd,
    preEnterOriginalCwd: options.preEnterOriginalCwd,
    activePath: resolved,
    worktreeName: name,
    ownership: "created",
    hookBased: true,
    ...(options.tmuxSessionName !== undefined ? { tmuxSession: options.tmuxSessionName } : {}),
    ...(branch !== null ? { managedBranch: branch } : {}),
    ...(head !== null ? { baseSha: head } : {}),
  };
  const branchInfo = branch ? ` on branch ${branch}` : "";
  return {
    state,
    result: {
      worktreePath: resolved,
      ...(branch !== null ? { worktreeBranch: branch } : {}),
      message: `Created worktree at ${resolved}${branchInfo}. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`,
    },
  };
}

interface ManagedWorktreeLocation {
  name: string;
  repoRoot: string;
  managedPath: string;
  managedBranch: string;
}

async function reuseManagedWorktree(
  options: CreateSessionWorktreeOptions,
  config: UserConfig,
  location: ManagedWorktreeLocation,
): Promise<SessionWorktreeEntry> {
  const { name, repoRoot, managedPath, managedBranch } = location;
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
  const freshBase =
    options.prNumber !== undefined || (config.worktree?.baseRef ?? "fresh") === "head"
      ? null
      : await resetReusedWorktreeToFreshBase(repoRoot, managedPath, managedBranch, {
          headSha: head,
          baselineSha: rawBaseline,
        });
  const baseline = freshBase ?? rawBaseline ?? head;
  const lock = await acquireSessionWorktreeLock(managedPath, repoRoot, options.ctx.sessionId);
  const state: SessionWorktreeState = {
    originalCwd: options.originalCwd,
    preEnterOriginalCwd: options.preEnterOriginalCwd,
    activePath: managedPath,
    worktreeName: name,
    managedBranch: resumedBranch,
    ownerRepoRoot: repoRoot,
    resumedExisting: true,
    ...(freshBase !== null ? { resetToFreshBase: true } : {}),
    ownership: lock.owned ? "created" : "enteredExisting",
    ...(options.tmuxSessionName !== undefined ? { tmuxSession: options.tmuxSessionName } : {}),
    ...(baseline !== null ? { baseSha: baseline } : {}),
    ...(lock.reason !== undefined ? { lockReason: lock.reason } : {}),
  };
  const preamble =
    freshBase !== null
      ? `Reused worktree at ${managedPath} on branch ${resumedBranch}. A worktree with this name already existed; its previous work was fully merged upstream, so it was reset to the current base.`
      : `Resumed worktree at ${managedPath} on branch ${resumedBranch}. A worktree with this name already existed and was resumed as-is — it may carry an earlier session’s commits. Pass a different name if you wanted a fresh worktree.`;
  return {
    state,
    result: {
      worktreePath: managedPath,
      worktreeBranch: resumedBranch,
      message: `${preamble} The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`,
    },
  };
}

async function createManagedWorktree(
  options: CreateSessionWorktreeOptions,
  config: UserConfig,
  location: ManagedWorktreeLocation,
): Promise<SessionWorktreeEntry> {
  const { name, repoRoot, managedPath, managedBranch } = location;
  const baseSha =
    options.prNumber !== undefined
      ? await resolvePrBaseSha(repoRoot, options.prNumber)
      : await resolveFreshBaseSha(repoRoot, config, options.ctx.cwd);

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
  const lock = await acquireSessionWorktreeLock(managedPath, repoRoot, options.ctx.sessionId);
  const state: SessionWorktreeState = {
    originalCwd: options.originalCwd,
    preEnterOriginalCwd: options.preEnterOriginalCwd,
    activePath: managedPath,
    worktreeName: name,
    managedBranch,
    baseSha,
    ownerRepoRoot: repoRoot,
    ownership: lock.owned ? "created" : "enteredExisting",
    ...(options.tmuxSessionName !== undefined ? { tmuxSession: options.tmuxSessionName } : {}),
    ...(lock.reason !== undefined ? { lockReason: lock.reason } : {}),
  };
  return {
    state,
    result: {
      worktreePath: managedPath,
      worktreeBranch: managedBranch,
      message: `Created worktree at ${managedPath} on branch ${managedBranch}. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`,
    },
  };
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
