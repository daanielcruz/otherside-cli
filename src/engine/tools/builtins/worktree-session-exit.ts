import type { Session } from "@/engine/session/record/state.ts";
import { loadCustomSessionTitle } from "@/engine/session/title/store.ts";
import {
  attachSessionWorktreeHost,
  clearLatchedWorktreeName,
  exitSessionWorktree,
  type SessionWorktreeState,
} from "@/engine/session/worktree.ts";
import { askGroup } from "@/kernel/channels/ask.ts";
import { getRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  killTmuxSession,
  tallyWorktreeChanges,
  type WorktreeChangeDigest,
} from "./worktree-exit.ts";

export type SessionExitWorktreeAction = "keep" | "keep-kill-tmux" | "remove" | "cancel";

export type SessionExitWorktreePrompt = {
  worktreePath: string;
  worktreeBranch?: string;
  tmuxSessionName?: string;
  changedFiles: number;
  commits: number;
  ownership: SessionWorktreeState["ownership"];
  /** Session title, when one exists — a titled clean worktree prompts instead of auto-removing. */
  sessionTitle?: string;
  /** Change/title summary line shown under the prompt heading. */
  subtitle: string;
  options: Array<{
    value: SessionExitWorktreeAction;
    label: string;
    description: string;
  }>;
};

export type SessionExitWorktreeResult = {
  action: "none" | "cancel" | "keep" | "remove";
  message: string;
  worktreePath?: string;
  worktreeBranch?: string;
  tmuxSessionName?: string;
  discardedFiles?: number;
  discardedCommits?: number;
};

/** True when `git status` succeeds in the worktree — it is still a live checkout. */
async function worktreeStatusOk(worktreePath: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "-C", worktreePath, "status", "--porcelain"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

function sessionCtxFrom(session: Session): RequestContext {
  attachSessionWorktreeHost(session);
  const wt = session.worktree;
  return {
    provider: "anthropic",
    model: "session-exit",
    effort: null,
    permissionMode: "default",
    sessionId: session.id,
    cwd: session.cwd,
    ...(wt !== null
      ? {
          originalCwd: wt.originalCwd,
          worktreeRoot: wt.activePath,
        }
      : {}),
  };
}

/** Prompt subtitle: pending changes first, then a titled-session hint, then the generic line. */
export function sessionExitSubtitle(
  summary: WorktreeChangeDigest,
  branch: string | undefined,
  sessionTitle: string | undefined,
): string {
  const hasFiles = summary.changedFiles > 0;
  const hasCommits = summary.commits > 0;
  const branchName = branch ?? "the worktree branch";
  const fileWord = summary.changedFiles === 1 ? "file" : "files";
  const commitWord = summary.commits === 1 ? "commit" : "commits";
  if (hasFiles && hasCommits) {
    return `You have ${summary.changedFiles} uncommitted ${fileWord} and ${summary.commits} ${commitWord} on ${branchName}. All will be lost if you remove.`;
  }
  if (hasFiles) {
    return `You have ${summary.changedFiles} uncommitted ${fileWord}. These will be lost if you remove the worktree.`;
  }
  if (hasCommits) {
    return `You have ${summary.commits} ${commitWord} on ${branchName}. The branch will be deleted if you remove the worktree.`;
  }
  if (sessionTitle !== undefined && sessionTitle.length > 0) {
    return `This session was named "${sessionTitle}". Keep the worktree to resume it later, or remove it to clean up.`;
  }
  return "You are working in a worktree. Keep it to continue working there, or remove it to clean up.";
}

async function defaultSessionExitAsk(
  prompt: SessionExitWorktreePrompt,
): Promise<SessionExitWorktreeAction> {
  const result = await askGroup([
    {
      question: `Exiting worktree session — ${prompt.subtitle}`,
      header: "Worktree exit",
      multiSelect: false,
      options: prompt.options.map((opt) => ({
        label: opt.label,
        description: opt.description,
      })),
    },
  ]);
  if (result.declined) return "cancel";
  const answer = result.answers[0]?.answer ?? "";
  const matched = prompt.options.find((opt) => opt.label === answer);
  if (matched) return matched.value;
  const lower = answer.toLowerCase();
  if (lower.includes("remove")) return "remove";
  if (lower.includes("kill tmux")) return "keep-kill-tmux";
  if (lower.includes("keep")) return "keep";
  return "cancel";
}

function buildSessionExitOptions(
  state: SessionWorktreeState,
  summary: WorktreeChangeDigest,
): SessionExitWorktreePrompt["options"] {
  const hasTmux = Boolean(state.tmuxSession);
  const removeDescription =
    summary.changedFiles > 0 || summary.commits > 0
      ? "All changes and commits will be lost."
      : "Clean up the worktree directory.";

  if (hasTmux) {
    return [
      {
        value: "keep",
        label: "Keep worktree and tmux session",
        description: `Stays at ${state.activePath}. Reattach with: tmux attach -t ${state.tmuxSession}`,
      },
      {
        value: "keep-kill-tmux",
        label: "Keep worktree, end tmux session",
        description: `Keeps worktree at ${state.activePath}, terminates tmux session.`,
      },
      {
        value: "remove",
        label: "Remove worktree and tmux session",
        description: removeDescription,
      },
    ];
  }

  return [
    {
      value: "keep",
      label: "Keep worktree",
      description: `Stays at ${state.activePath}`,
    },
    {
      value: "remove",
      label: "Remove worktree",
      description: removeDescription,
    },
  ];
}

/**
 * Session-end keep/remove lifecycle.
 * - No active worktree → no-op
 * - enteredExisting → keep, no prompt (never remove a tree we did not create)
 * - created + pristine + untitled → auto-remove (silent clean exit)
 * - created + pristine + titled → prompt (the title marks a resumable session)
 * - created + dirty (or probe fail) → prompt keep/remove; tmux killed on remove,
 *   left running on keep (name returned for reattach)
 */
export async function resolveWorktreeOnSessionExit(
  session: Session,
  options?: {
    ask?: (prompt: SessionExitWorktreePrompt) => Promise<SessionExitWorktreeAction>;
    /** When non-interactive, default action (default: keep). */
    nonInteractiveDefault?: "keep" | "remove";
    /** Force kill tmux even on keep (e.g. user chose "keep, end tmux"). */
    killTmuxOnKeep?: boolean;
  },
): Promise<SessionExitWorktreeResult> {
  const state = session.worktree;
  if (state === null) {
    return { action: "none", message: "No active worktree session" };
  }

  const rawSummary = await tallyWorktreeChanges(state.activePath, state.baseSha);
  // A worktree whose git status probe fails outright (directory removed out
  // from under the session) gets a silent leave, never a keep/remove prompt.
  if (
    state.ownership !== "enteredExisting" &&
    !state.hookBased &&
    rawSummary === null &&
    !(await worktreeStatusOk(state.activePath))
  ) {
    clearLatchedWorktreeName();
    try {
      await exitSessionWorktree(sessionCtxFrom(session), {
        action: "keep",
        restoreStrategy: "parent-chain",
      });
    } catch {
      // already detached or gone
    }
    const tmuxNote = state.tmuxSession
      ? `. Detached tmux session ${state.tmuxSession} may still be running — end it with: tmux kill-session -t ${state.tmuxSession}`
      : "";
    return {
      action: "keep",
      worktreePath: state.activePath,
      ...(state.managedBranch !== undefined ? { worktreeBranch: state.managedBranch } : {}),
      message: `Worktree at ${state.activePath} is no longer accessible — exiting${tmuxNote}`,
    };
  }

  const summary = rawSummary ?? ({ changedFiles: 1, commits: 0 } satisfies WorktreeChangeDigest);
  const pristine = summary.changedFiles === 0 && summary.commits === 0;
  const sessionTitle = (await loadCustomSessionTitle(session.id).catch(() => null)) ?? undefined;
  const runtime = getRuntimeKind();
  const interactive = runtime === "interactive" || runtime === null;
  const ask = options?.ask ?? defaultSessionExitAsk;
  const nonInteractiveDefault = options?.nonInteractiveDefault ?? "keep";

  let action: SessionExitWorktreeAction = "keep";
  let killTmuxOnKeep = options?.killTmuxOnKeep === true;
  let enteredExistingExit = false;

  if (state.ownership === "enteredExisting") {
    // Never remove foreign/entered trees on session exit; leave silently.
    action = "keep";
    enteredExistingExit = true;
  } else if (pristine && sessionTitle === undefined) {
    // Clean untitled worktree: remove silently.
    action = "remove";
  } else if (!interactive) {
    action = nonInteractiveDefault;
  } else {
    const prompt: SessionExitWorktreePrompt = {
      worktreePath: state.activePath,
      ...(state.managedBranch !== undefined ? { worktreeBranch: state.managedBranch } : {}),
      ...(state.tmuxSession !== undefined ? { tmuxSessionName: state.tmuxSession } : {}),
      changedFiles: summary.changedFiles,
      commits: summary.commits,
      ownership: state.ownership,
      ...(sessionTitle !== undefined ? { sessionTitle } : {}),
      subtitle: sessionExitSubtitle(summary, state.managedBranch, sessionTitle),
      options: buildSessionExitOptions(state, summary),
    };
    action = await ask(prompt);
    if (action === "cancel") {
      return {
        action: "cancel",
        worktreePath: state.activePath,
        ...(state.managedBranch !== undefined ? { worktreeBranch: state.managedBranch } : {}),
        ...(state.tmuxSession !== undefined ? { tmuxSessionName: state.tmuxSession } : {}),
        message: "Worktree exit cancelled",
      };
    }
    if (action === "keep-kill-tmux") {
      killTmuxOnKeep = true;
      action = "keep";
    }
  }

  const ctx = sessionCtxFrom(session);
  const tmuxName = state.tmuxSession;
  const worktreePath = state.activePath;
  const worktreeBranch = state.managedBranch;

  if (action === "remove") {
    if (tmuxName) {
      await killTmuxSession(tmuxName);
    }
    try {
      const foundation = await exitSessionWorktree(ctx, {
        action: "remove",
        discardChanges: !pristine,
        restoreStrategy: "parent-chain",
      });
      if (foundation.action === "keep") {
        return {
          action: "keep",
          worktreePath,
          ...(worktreeBranch !== undefined ? { worktreeBranch } : {}),
          message: `Worktree could not be removed — kept at ${worktreePath}`,
        };
      }
      if (pristine) {
        return {
          action: "remove",
          worktreePath,
          ...(worktreeBranch !== undefined ? { worktreeBranch } : {}),
          discardedFiles: 0,
          discardedCommits: 0,
          message: "Worktree removed (no changes)",
        };
      }
      const tmuxNote = tmuxName ? " Tmux session terminated." : "";
      const branchName = worktreeBranch ?? "the worktree branch";
      const commitWord = summary.commits === 1 ? "commit" : "commits";
      const detail =
        summary.commits > 0 && summary.changedFiles > 0
          ? ` ${summary.commits} ${commitWord} and uncommitted changes were discarded.`
          : summary.commits > 0
            ? ` ${summary.commits} ${commitWord} on ${branchName} ${summary.commits === 1 ? "was" : "were"} discarded.`
            : summary.changedFiles > 0
              ? " Uncommitted changes were discarded."
              : "";
      return {
        action: "remove",
        worktreePath,
        ...(worktreeBranch !== undefined ? { worktreeBranch } : {}),
        discardedFiles: summary.changedFiles,
        discardedCommits: summary.commits,
        message: `Worktree removed.${detail}${tmuxNote}`,
      };
    } catch (e) {
      // Fall back to keep semantics if remove fails mid-flight.
      try {
        await exitSessionWorktree(ctx, { action: "keep", restoreStrategy: "parent-chain" });
      } catch {
        // already detached or gone
      }
      return {
        action: "keep",
        worktreePath,
        ...(worktreeBranch !== undefined ? { worktreeBranch } : {}),
        ...(tmuxName !== undefined ? { tmuxSessionName: tmuxName } : {}),
        message: `Worktree cleanup failed (${e instanceof Error ? e.message : String(e)}); kept at ${worktreePath}`,
      };
    }
  }

  // keep
  if (killTmuxOnKeep && tmuxName) {
    await killTmuxSession(tmuxName);
  }
  await exitSessionWorktree(ctx, { action: "keep", restoreStrategy: "parent-chain" });
  if (enteredExistingExit) {
    return {
      action: "keep",
      worktreePath,
      ...(worktreeBranch !== undefined ? { worktreeBranch } : {}),
      ...(tmuxName !== undefined ? { tmuxSessionName: tmuxName } : {}),
      message: `Returned to ${state.originalCwd} (worktree at ${worktreePath} left in place)`,
    };
  }
  const branchSuffix = worktreeBranch ? ` on branch ${worktreeBranch}` : "";
  const message =
    killTmuxOnKeep && tmuxName
      ? `Worktree kept at ${worktreePath}${branchSuffix}. Tmux session terminated.`
      : tmuxName
        ? `Worktree kept. Your work is saved at ${worktreePath}${branchSuffix}. Reattach to tmux session with: tmux attach -t ${tmuxName}`
        : `Worktree kept. Your work is saved at ${worktreePath}${branchSuffix}`;
  return {
    action: "keep",
    worktreePath,
    ...(worktreeBranch !== undefined ? { worktreeBranch } : {}),
    ...(tmuxName !== undefined && !killTmuxOnKeep ? { tmuxSessionName: tmuxName } : {}),
    message,
  };
}
