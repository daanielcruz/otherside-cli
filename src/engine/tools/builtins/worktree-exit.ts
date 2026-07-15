import type { Session } from "@/engine/session/record/state.ts";
import {
  attachSessionWorktreeHost,
  exitSessionWorktree,
  getActiveWorktree,
  type SessionWorktreeState,
} from "@/engine/session/worktree.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import ExitWorktreeSchema from "@/harness/tools/ExitWorktree/tool.json" with { type: "json" };
import { askGroup } from "@/kernel/channels/ask.ts";
import { getRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
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
  options: Array<{
    value: SessionExitWorktreeAction;
    label: string;
    description: string;
  }>;
};

export type SessionExitWorktreeResult = {
  action: "none" | "keep" | "remove";
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
  return { tool_use_id: toolUseId, content: msg, is_error: true };
}

function ok(toolUseId: string, payload: unknown): ToolResult {
  return { tool_use_id: toolUseId, content: JSON.stringify(payload) };
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

async function defaultSessionExitAsk(
  prompt: SessionExitWorktreePrompt,
): Promise<SessionExitWorktreeAction> {
  const result = await askGroup([
    {
      question: "Exiting worktree session — keep or remove the worktree?",
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

  if (state.ownership === "enteredExisting") {
    // Never offer remove for worktrees we did not create.
    if (hasTmux) {
      return [
        {
          value: "keep",
          label: "Keep worktree and tmux session",
          description: `Stays at ${state.activePath}. Reattach with: tmux attach -t ${state.tmuxSession}`,
        },
        {
          value: "keep-kill-tmux",
          label: "Keep worktree, kill tmux session",
          description: `Keeps worktree at ${state.activePath}, terminates tmux session.`,
        },
      ];
    }
    return [
      {
        value: "keep",
        label: "Keep worktree",
        description: `Stays at ${state.activePath}`,
      },
    ];
  }

  if (hasTmux) {
    return [
      {
        value: "keep",
        label: "Keep worktree and tmux session",
        description: `Stays at ${state.activePath}. Reattach with: tmux attach -t ${state.tmuxSession}`,
      },
      {
        value: "keep-kill-tmux",
        label: "Keep worktree, kill tmux session",
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
 * - enteredExisting → keep only (never remove a tree we did not create)
 * - created + pristine → auto-remove (silent clean exit)
 * - created + dirty (or probe fail) → prompt keep/remove; tmux killed on remove,
 *   left running on keep (name returned for reattach)
 */
export async function resolveWorktreeOnSessionExit(
  session: Session,
  options?: {
    ask?: (prompt: SessionExitWorktreePrompt) => Promise<SessionExitWorktreeAction>;
    /** When non-interactive, default action (default: keep). */
    nonInteractiveDefault?: "keep" | "remove";
    /** Force kill tmux even on keep (e.g. user chose "keep, kill tmux"). */
    killTmuxOnKeep?: boolean;
  },
): Promise<SessionExitWorktreeResult> {
  const state = session.worktree;
  if (state === null) {
    return { action: "none", message: "No active worktree session" };
  }

  const summary =
    (await countWorktreeChanges(state.activePath, state.baseSha)) ??
    ({ changedFiles: 1, commits: 0 } satisfies WorktreeChangeSummary);
  const pristine = summary.changedFiles === 0 && summary.commits === 0;
  const runtime = getRuntimeKind();
  const interactive = runtime === "interactive" || runtime === null;
  const ask = options?.ask ?? defaultSessionExitAsk;
  const nonInteractiveDefault = options?.nonInteractiveDefault ?? "keep";

  let action: SessionExitWorktreeAction = "keep";
  let killTmuxOnKeep = options?.killTmuxOnKeep === true;

  if (state.ownership === "enteredExisting") {
    // Never remove foreign/entered trees on session exit.
    action = "keep";
  } else if (pristine) {
    // Clean created worktree: remove silently (CC parity).
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
      options: buildSessionExitOptions(state, summary),
    };
    action = await ask(prompt);
    if (action === "cancel") {
      // Escape / cancel aborts the process exit path's destructive choice → keep.
      action = "keep";
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
      await exitSessionWorktree(ctx, {
        action: "remove",
        discardChanges: !pristine,
      });
      const discardParts: string[] = [];
      if (summary.commits > 0) {
        discardParts.push(`${summary.commits} ${summary.commits === 1 ? "commit" : "commits"}`);
      }
      if (summary.changedFiles > 0) {
        discardParts.push(
          `${summary.changedFiles} uncommitted ${summary.changedFiles === 1 ? "file" : "files"}`,
        );
      }
      const discardNote =
        discardParts.length > 0 ? ` Discarded ${discardParts.join(" and ")}.` : "";
      const tmuxNote = tmuxName ? " Tmux session terminated." : "";
      return {
        action: "remove",
        worktreePath,
        ...(worktreeBranch !== undefined ? { worktreeBranch } : {}),
        discardedFiles: summary.changedFiles,
        discardedCommits: summary.commits,
        message: `Worktree removed at ${worktreePath}.${discardNote}${tmuxNote}`,
      };
    } catch (e) {
      // Fall back to keep semantics if remove fails mid-flight.
      try {
        await exitSessionWorktree(ctx, { action: "keep" });
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
  await exitSessionWorktree(ctx, { action: "keep" });
  const tmuxNote =
    tmuxName && !killTmuxOnKeep
      ? ` Reattach to tmux session with: tmux attach -t ${tmuxName}`
      : killTmuxOnKeep && tmuxName
        ? " Tmux session terminated."
        : "";
  return {
    action: "keep",
    worktreePath,
    ...(worktreeBranch !== undefined ? { worktreeBranch } : {}),
    ...(tmuxName !== undefined && !killTmuxOnKeep ? { tmuxSessionName: tmuxName } : {}),
    message: `Worktree kept at ${worktreePath}${worktreeBranch ? ` on branch ${worktreeBranch}` : ""}.${tmuxNote}`,
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
    const discardChanges = args.discard_changes === true;

    const active = getActiveWorktree(ctx);
    if (active === null) {
      return okText(call.id, NO_ACTIVE_SESSION_MESSAGE);
    }

    if (action === "remove" && active.ownership === "enteredExisting") {
      return err(
        call.id,
        `This session entered an existing worktree (${active.activePath}); it was not created by EnterWorktree, so this tool will not remove it. Use action: "keep" to return to ${active.originalCwd}, then remove the worktree manually with \`git worktree remove\` if desired.`,
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

    // Pre-count for discard reporting (best-effort; zeros if probe fails after gate).
    const preSummary = (await countWorktreeChanges(worktreePath, active.baseSha)) ?? {
      changedFiles: 0,
      commits: 0,
    };

    if (action === "keep") {
      try {
        await exitSessionWorktree(ctx, { action: "keep" });
      } catch (e) {
        return err(call.id, e instanceof Error ? e.message : String(e));
      }
      const tmuxNote = tmuxSessionName
        ? ` Tmux session ${tmuxSessionName} is still running; reattach with: tmux attach -t ${tmuxSessionName}`
        : "";
      return ok(call.id, {
        action: "keep" as const,
        originalCwd,
        worktreePath,
        ...(worktreeBranch !== undefined ? { worktreeBranch } : {}),
        ...(tmuxSessionName !== undefined ? { tmuxSessionName } : {}),
        message: `Exited worktree. Your work is preserved at ${worktreePath}${worktreeBranch ? ` on branch ${worktreeBranch}` : ""}. Session is now back in ${originalCwd}.${tmuxNote}`,
      });
    }

    // action === "remove"
    if (tmuxSessionName) {
      await killTmuxSession(tmuxSessionName);
    }

    try {
      const result = await exitSessionWorktree(ctx, {
        action: "remove",
        discardChanges,
      });
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
      return ok(call.id, {
        action: "remove" as const,
        originalCwd: result.originalCwd,
        worktreePath: result.worktreePath ?? worktreePath,
        ...(result.worktreeBranch !== undefined
          ? { worktreeBranch: result.worktreeBranch }
          : worktreeBranch !== undefined
            ? { worktreeBranch }
            : {}),
        discardedFiles,
        discardedCommits,
        message: `Exited and removed worktree at ${worktreePath}.${discardNote} Session is now back in ${result.originalCwd}.`,
      });
    } catch (e) {
      return err(call.id, e instanceof Error ? e.message : String(e));
    }
  },
};
