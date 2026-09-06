import { isRootAgentRun } from "@/engine/background/subagents/fork/spawn-depth.ts";
import {
  exitSessionWorktree,
  getActiveWorktree,
  isAgentContext,
} from "@/engine/session/worktree.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import ExitWorktreeSchema from "@/harness/tools/ExitWorktree/tool.json" with { type: "json" };
import { runProcessSafely } from "@/kernel/std/proc/run-process.ts";
import { setTrackedCwd } from "@/kernel/std/state/cwd-state.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

interface Input {
  action?: unknown;
  discard_changes?: unknown;
}

export type WorktreeChangeDigest = {
  changedFiles: number;
  commits: number;
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

/**
 * Count uncommitted files and commits ahead of `baseSha` (original HEAD).
 * Returns null on probe failure (fail-closed for destructive remove).
 */
export async function tallyWorktreeChanges(
  worktreePath: string,
  baseSha: string | undefined,
): Promise<WorktreeChangeDigest | null> {
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

export const ExitWorktree: ToolHandler = {
  schema: {
    name: ExitWorktreeSchema.name,
    description: ExitWorktreeSchema.description,
    inputSchema: ExitWorktreeSchema.inputSchema,
  },
  render: {
    isTransparent: () => true,
    userFacingLabel(input) {
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
      const summary = await tallyWorktreeChanges(active.activePath, active.baseSha);
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
    const preSummary = (await tallyWorktreeChanges(worktreePath, active.baseSha)) ?? {
      changedFiles: 0,
      commits: 0,
    };

    if (action === "keep") {
      try {
        const result = await exitSessionWorktree(ctx, { action: "keep" });
        if (isRootAgentRun(ctx)) setTrackedCwd(result.restoredCwd);
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
      if (isRootAgentRun(ctx)) setTrackedCwd(result.restoredCwd);
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
