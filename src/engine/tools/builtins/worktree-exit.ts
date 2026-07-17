import { isMainAgentContext } from "@/engine/background/subagents/fork/spawn-depth.ts";
import type { Session } from "@/engine/session/record/state.ts";
import { loadCustomSessionTitle } from "@/engine/session/title/store.ts";
import {
  attachSessionWorktreeHost,
  clearLatchedWorktreeName,
  exitSessionWorktree,
  getActiveWorktree,
  isAgentContext,
  type SessionWorktreeState,
} from "@/engine/session/worktree.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import ExitWorktreeSchema from "@/harness/tools/ExitWorktree/tool.json" with { type: "json" };
import { askGroup } from "@/kernel/channels/ask.ts";
import { getRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
import { setTrackedCwd } from "@/kernel/std/state/cwd-state.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { runProcessSafely } from "@/utils/execFileNoThrow.ts";

interface Input {
  action?: unknown;
  discard_changes?: unknown;
}

export type WorktreeChangeSummary = {
  changedFiles: number;
  commits: number;
};

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

const NO_ACTIVE_SESSION_MESSAGE =
  "No-op: there is no active EnterWorktree session to exit. This tool only operates on worktrees created by EnterWorktree in the current session — it will not touch worktrees created manually or in a previous session. No filesystem changes were made.";

function err(toolUseId: string, msg: string): ToolResult {
  return {
    tool_use_id: toolUseId,
    content: `<tool_use_error>${msg}</tool_use_error>`,
    is_error: true,
  };
}

function okText(toolUseId: string, message: string): ToolResult {
  return { tool_use_id: toolUseId, content: message };
}

/** Kill a tmux session by name. Returns true when tmux reports success. */
export async function killTmuxSession(sessionName: string): Promise<boolean> {
  const { code } = await runProcessSafely("tmux", ["kill-session", "-t", sessionName], {
    timeout: 5_000,
    useCwd: false,
    preserveOutputOnError: false,
  });
  return code === 0;
}

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

/**
 * Count uncommitted files and commits ahead of `baseSha` (original HEAD).
 * Returns null on probe failure (fail-closed for destructive remove).
 */
export async function countWorktreeChanges(
  worktreePath: string,
  baseSha: string | undefined,
): Promise<WorktreeChangeSummary | null> {
  try {
    const status = Bun.spawn(["git", "-C", worktreePath, "status", "--porcelain"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const statusOut = await new Response(status.stdout).text();
    const statusCode = await status.exited;
    if (statusCode !== 0) return null;
    const changedFiles = statusOut.split("\n").filter((line) => line.trim().length > 0).length;

    if (!baseSha || baseSha.length === 0) {
      // Without a baseline, commits cannot be verified — fail closed for remove gates.
      return null;
    }

    const revList = Bun.spawn(
      ["git", "-C", worktreePath, "rev-list", "--count", `${baseSha}..HEAD`],
      {
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    const revOut = await new Response(revList.stdout).text();
    const revCode = await revList.exited;
    if (revCode !== 0) return null;
    const commits = Number.parseInt(revOut.trim(), 10) || 0;
    return { changedFiles, commits };
  } catch {
    return null;
  }
}

function restorationMessage(originalCwd: string, restoredCwd: string): string {
  return restoredCwd === originalCwd
    ? `Session is now back in ${originalCwd}.`
    : `The original directory ${originalCwd} no longer exists, so the session is now in ${restoredCwd}. Consider restarting Otherside from an existing directory.`;
}

function formatChangeParts(
  changedFiles: number,
  commits: number,
  branch: string | undefined,
): string[] {
  const parts: string[] = [];
  if (changedFiles > 0) {
    parts.push(`${changedFiles} uncommitted ${changedFiles === 1 ? "file" : "files"}`);
  }
  if (commits > 0) {
    parts.push(
      `${commits} ${commits === 1 ? "commit" : "commits"} on ${branch ?? "the worktree branch"}`,
    );
  }
  return parts;
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
  summary: WorktreeChangeSummary,
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
  summary: WorktreeChangeSummary,
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

  const rawSummary = await countWorktreeChanges(state.activePath, state.baseSha);
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

  const summary = rawSummary ?? ({ changedFiles: 1, commits: 0 } satisfies WorktreeChangeSummary);
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

export const ExitWorktree: ToolHandler = {
  schema: {
    name: ExitWorktreeSchema.name,
    description: ExitWorktreeSchema.description,
    inputSchema: ExitWorktreeSchema.inputSchema,
  },
  render: {
    isTransparent: () => true,
    userFacingName(input) {
      const args = (input ?? {}) as Input;
      return args.action === "remove" ? "Cleaning up worktree" : "Exiting worktree";
    },
    summarizeArgs(input) {
      const args = (input ?? {}) as Input;
      if (args.action === "remove") {
        return args.discard_changes === true ? "remove (discard changes)" : "remove";
      }
      if (args.action === "keep") return "keep";
      return "";
    },
  },
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as Input;
    const action = args.action;
    if (action !== "keep" && action !== "remove") {
      return err(call.id, '`action` must be "keep" or "remove"');
    }
    // Agents never relocate the session they belong to — rejected before any
    // state is read, even when this agent owns the controller that entered.
    if (isAgentContext(ctx)) {
      return err(
        call.id,
        "ExitWorktree cannot be called from a subagent — this agent is already isolated; use Bash with `cd` for directory changes within it.",
      );
    }
    const active = getActiveWorktree(ctx);
    const discardChanges = args.discard_changes === true;

    if (active === null) return err(call.id, NO_ACTIVE_SESSION_MESSAGE);

    if (action === "remove" && active.ownership === "enteredExisting") {
      return err(
        call.id,
        `This session is not the owner of the worktree at ${active.activePath} — it either entered a pre-existing worktree via EnterWorktree({path}) or resumed into a checkout whose liveness lock another running Otherside session still holds — so this tool will not remove it. Use action: "keep" to return to ${active.originalCwd}. If no other session is using it, remove it yourself with \`git worktree remove\`; while a live session's lock is present, git will refuse and name the owner.`,
      );
    }

    if (action === "remove" && !discardChanges) {
      const summary = await countWorktreeChanges(active.activePath, active.baseSha);
      if (summary === null) {
        return err(
          call.id,
          `Could not verify worktree state at ${active.activePath}. Refusing to remove without explicit confirmation. Re-invoke with discard_changes: true to proceed — or use action: "keep" to preserve the worktree.`,
        );
      }
      const { changedFiles, commits } = summary;
      if (changedFiles > 0 || commits > 0) {
        const parts = formatChangeParts(changedFiles, commits, active.managedBranch);
        return err(
          call.id,
          `Worktree has ${parts.join(" and ")}. Removing will discard this work permanently. Confirm with the user, then re-invoke with discard_changes: true — or use action: "keep" to preserve the worktree.`,
        );
      }
    }

    const tmuxSessionName = active.tmuxSession;
    const worktreePath = active.activePath;
    const worktreeBranch = active.managedBranch;
    const originalCwd = active.originalCwd;
    const preSummary = (await countWorktreeChanges(worktreePath, active.baseSha)) ?? {
      changedFiles: 0,
      commits: 0,
    };

    if (action === "keep") {
      try {
        const result = await exitSessionWorktree(ctx, { action: "keep" });
        if (isMainAgentContext(ctx)) setTrackedCwd(result.restoredCwd);
        const tmuxNote = tmuxSessionName
          ? ` Tmux session ${tmuxSessionName} is still running; reattach with: tmux attach -t ${tmuxSessionName}`
          : "";
        return okText(
          call.id,
          `Exited worktree. Your work is preserved at ${worktreePath}${worktreeBranch ? ` on branch ${worktreeBranch}` : ""}. ${restorationMessage(originalCwd, result.restoredCwd)}${tmuxNote}`,
        );
      } catch (error) {
        return err(call.id, error instanceof Error ? error.message : String(error));
      }
    }

    if (tmuxSessionName) await killTmuxSession(tmuxSessionName);
    try {
      const result = await exitSessionWorktree(ctx, {
        action: "remove",
        discardChanges,
      });
      if (isMainAgentContext(ctx)) setTrackedCwd(result.restoredCwd);
      if (result.action === "keep") {
        return okText(
          call.id,
          `Exited worktree but could not remove it — kept at ${worktreePath}. ${restorationMessage(originalCwd, result.restoredCwd)}`,
        );
      }

      const discardedFiles = result.discardedFiles ?? preSummary.changedFiles;
      const discardedCommits = result.discardedCommits ?? preSummary.commits;
      const discardParts: string[] = [];
      if (discardedCommits > 0) {
        discardParts.push(`${discardedCommits} ${discardedCommits === 1 ? "commit" : "commits"}`);
      }
      if (discardedFiles > 0) {
        discardParts.push(
          `${discardedFiles} uncommitted ${discardedFiles === 1 ? "file" : "files"}`,
        );
      }
      const discardNote =
        discardParts.length > 0 ? ` Discarded ${discardParts.join(" and ")}.` : "";
      return okText(
        call.id,
        `Exited and removed worktree at ${worktreePath}.${discardNote} ${restorationMessage(originalCwd, result.restoredCwd)}`,
      );
    } catch (error) {
      return err(call.id, error instanceof Error ? error.message : String(error));
    }
  },
};
