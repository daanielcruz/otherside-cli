import { randomUUID } from "node:crypto";
import { isRootAgentRun } from "@/engine/background/subagents/fork/spawn-depth.ts";
import { enterSessionWorktree } from "@/engine/session/worktree.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import EnterWorktreeSchema from "@/harness/tools/EnterWorktree/tool.json" with { type: "json" };
import { setTrackedCwd } from "@/kernel/std/state/cwd-state.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

interface Input {
  name?: unknown;
  path?: unknown;
}

const WORKTREE_NAME_COMPONENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const WORKTREE_NAME_CHARACTER_LIMIT = 64;

type WorktreeNameIssue =
  | { kind: "navigation" }
  | { kind: "git-directory"; component: string }
  | { kind: "grammar" };

function inspectWorktreeName(name: string): WorktreeNameIssue | undefined {
  for (const component of name.split("/")) {
    if (component === "." || component === "..") return { kind: "navigation" };
    if (component.toLowerCase().replace(/\.+$/, "") === ".git") {
      return { kind: "git-directory", component };
    }
    if (!WORKTREE_NAME_COMPONENT_PATTERN.test(component)) return { kind: "grammar" };
  }
  return undefined;
}

function err(toolUseId: string, msg: string): ToolResult {
  return {
    tool_use_id: toolUseId,
    content: `<tool_use_error>${msg}</tool_use_error>`,
    is_error: true,
  };
}

function ok(toolUseId: string, message: string): ToolResult {
  return { tool_use_id: toolUseId, content: message };
}

export function validateWorktreeName(name: string): void {
  if (name.length > WORKTREE_NAME_CHARACTER_LIMIT) {
    throw new Error(
      `Invalid worktree name: must be ${WORKTREE_NAME_CHARACTER_LIMIT} characters or fewer (got ${name.length})`,
    );
  }

  const issue = inspectWorktreeName(name);
  if (issue === undefined) return;
  if (issue.kind === "navigation") {
    throw new Error(`Invalid worktree name "${name}": must not contain "." or ".." path segments`);
  }
  if (issue.kind === "git-directory") {
    throw new Error(
      `Invalid worktree name "${name}": "${issue.component}" is a reserved git directory name`,
    );
  }
  throw new Error(
    `Invalid worktree name "${name}": each "/"-separated segment must be non-empty and contain only letters, digits, dots, underscores, and dashes`,
  );
}

/** Random slug for when neither `name` nor `path` is provided. */
export function generateWorktreeSlug(): string {
  return `wt-${randomUUID().slice(0, 8)}`;
}

export const EnterWorktree: ToolHandler = {
  schema: {
    name: EnterWorktreeSchema.name,
    description: EnterWorktreeSchema.description,
    inputSchema: EnterWorktreeSchema.inputSchema,
  },
  render: {
    isTransparent: () => true,
    userFacingLabel(input) {
      const args = (input ?? {}) as Input;
      return typeof args.path === "string" && args.path.length > 0
        ? "Entering worktree"
        : "Creating worktree";
    },
    summarizeArgs(input) {
      const args = (input ?? {}) as Input;
      if (typeof args.path === "string" && args.path.length > 0) return args.path;
      if (typeof args.name === "string" && args.name.length > 0) return args.name;
      return "";
    },
  },
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as Input;
    const name = typeof args.name === "string" ? args.name : undefined;
    const path = typeof args.path === "string" ? args.path : undefined;

    const hasName = name !== undefined && name.length > 0;
    const hasPath = path !== undefined && path.length > 0;

    if (hasName && hasPath) {
      return err(call.id, "Provide at most one of `name` or `path`, not both.");
    }

    if (name !== undefined) {
      try {
        validateWorktreeName(name);
      } catch (e) {
        return err(call.id, e instanceof Error ? e.message : String(e));
      }
    }

    const opts: { name?: string; path?: string } = hasPath
      ? { path }
      : { name: hasName ? name : generateWorktreeSlug() };

    try {
      const result = await enterSessionWorktree(ctx, opts);
      if (isRootAgentRun(ctx)) setTrackedCwd(result.worktreePath);
      return ok(call.id, result.message);
    } catch (e) {
      return err(call.id, e instanceof Error ? e.message : String(e));
    }
  },
};
