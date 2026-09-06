import { setTaskOutputSession } from "@/engine/background/tasks/output-files.ts";
import type { loadSessionForResume, Session } from "@/engine/session/index.ts";
import { initScratchpadDir } from "@/harness/routines/scratchpad.ts";
import type { loadConfig } from "@/kernel/config/config.ts";
import { setTrackedCwd } from "@/kernel/std/state/cwd-state.ts";

/**
 * Launch-time worktree wiring, mirroring the launch flag semantics:
 * `--worktree [name]` creates/reenters a session worktree before anything
 * renders (the flag wins over a resumed session's recorded worktree); a plain
 * resume restores the worktree recorded in the transcript stamp (project-slot
 * fallback for pre-stamp transcripts), when present.
 */
export async function applyStartupWorktree(args: {
  session: Session;
  cfg: Awaited<ReturnType<typeof loadConfig>>;
  worktree: { name: string | null } | null;
  tmux: boolean;
  isResume: boolean;
  resumeRecords: Awaited<ReturnType<typeof loadSessionForResume>>["records"];
}): Promise<void> {
  const { session, cfg, worktree, tmux, isResume, resumeRecords } = args;
  if (worktree === null && !isResume) return;
  const {
    attachSessionWorktreeHost,
    enterSessionWorktree,
    parsePRReference,
    readProjectWorktreeSlot,
    resolveWorktreeLaunchBase,
    restoreSessionWorktreeOnResume,
    stampedWorktreeStateFrom,
    worktreeTmuxSessionName,
  } = await import("@/engine/session/worktree.ts");
  attachSessionWorktreeHost(session);

  if (worktree === null) {
    // The transcript stamp is the restore source of truth; the project slot
    // only covers transcripts that predate stamps.
    const stamped = stampedWorktreeStateFrom(resumeRecords);
    const recorded = stamped.stamped ? stamped.state : readProjectWorktreeSlot(session.id);
    if (recorded === null) return;
    const restore = await restoreSessionWorktreeOnResume(session, recorded);
    if (restore.warning !== undefined) process.stderr.write(`${restore.warning}\n`);
    // A failed restore may have re-homed the session too (dead worktree).
    await syncSessionCwdState(session);
    return;
  }

  const { listEnabledHookEntries } = await import("@/engine/plugins/registry.ts");
  const hasCreateHook =
    (cfg.hooks?.WorktreeCreate?.length ?? 0) > 0 ||
    listEnabledHookEntries("WorktreeCreate").length > 0;
  const { baseCwd, gitRepo } = await resolveWorktreeLaunchBase(session.cwd);
  if (!gitRepo && !hasCreateHook) {
    process.stderr.write(
      `Error: Can only use --worktree in a git repository, but ${session.cwd} is not a git repository. Configure a WorktreeCreate hook in settings.json to use --worktree with other VCS systems.\n`,
    );
    process.exit(1);
  }
  if (baseCwd !== session.cwd) {
    // Launched inside a linked worktree: anchor the session on the main checkout.
    session.cwd = baseCwd;
    if (!isResume) session.storageCwd = baseCwd;
  }
  // `--worktree #123` / `--worktree <PR URL>` name the worktree pr-<N> and
  // base it on the PR head instead of the default branch.
  const prNumber = worktree.name !== null ? parsePRReference(worktree.name) : null;
  const name = prNumber !== null ? `pr-${prNumber}` : worktree.name;
  const ctx = {
    provider: "anthropic",
    model: "startup",
    effort: null,
    permissionMode: "default",
    sessionId: session.id,
    cwd: session.cwd,
  } as unknown as Parameters<typeof enterSessionWorktree>[0];
  try {
    await enterSessionWorktree(ctx, {
      ...(name !== null ? { name } : {}),
      ...(prNumber !== null ? { prNumber } : {}),
      ...(tmux && name !== null ? { tmuxSessionName: worktreeTmuxSessionName(baseCwd, name) } : {}),
    });
  } catch (error) {
    process.stderr.write(
      `Error creating worktree: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
  if (tmux) await applyCompanionTmux(session);
  await syncSessionCwdState(session);
}

/**
 * `--tmux` companion for a `--worktree` launch: a detached tmux session rooted
 * in the worktree, recorded on the worktree state so the exit dialog offers
 * the keep/kill-tmux choices and remove tears it down.
 */
async function applyCompanionTmux(session: Session): Promise<void> {
  if (session.worktree === null) return;
  const { persistProjectWorktreeSlot, worktreeTmuxSessionName } = await import(
    "@/engine/session/worktree.ts"
  );
  // An auto-generated worktree name is only known after enter.
  const name =
    session.worktree.tmuxSession ??
    (session.worktree.worktreeName !== undefined
      ? worktreeTmuxSessionName(
          session.worktree.ownerRepoRoot ?? session.worktree.originalCwd,
          session.worktree.worktreeName,
        )
      : null);
  if (name === null) return;
  try {
    const proc = Bun.spawn(["tmux", "new-session", "-d", "-s", name, "-c", session.cwd], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0) {
      process.stderr.write(`Warning: Failed to create tmux session: ${stderr.trim()}\n`);
      return;
    }
    session.worktree.tmuxSession = name;
    await persistProjectWorktreeSlot(session.worktree, session.id);
    process.stdout.write(`Created tmux session: ${name}\nTo attach: tmux attach -t ${name}\n`);
  } catch (error) {
    process.stderr.write(
      `Warning: Failed to create tmux session: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

/** Re-anchor cwd-derived session state after a launch-time worktree switch. */
async function syncSessionCwdState(session: Session): Promise<void> {
  setTrackedCwd(session.cwd);
  initScratchpadDir(session.cwd, session.id);
  setTaskOutputSession({ sessionId: session.id, cwd: session.cwd });
  const { currentGitBranch } = await import("@/engine/session/paths.ts");
  const gitBranch = currentGitBranch(session.cwd);
  if (gitBranch) session.gitBranch = gitBranch;
  else delete session.gitBranch;
}
