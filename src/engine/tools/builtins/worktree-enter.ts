import { randomUUID } from "node:crypto";
import { isMainAgentContext } from "@/engine/background/subagents/fork/spawn-depth.ts";
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

const VALID_WORKTREE_SLUG_SEGMENT = /^[A-Za-z0-9._-]+$/;
const MAX_WORKTREE_SLUG_LENGTH = 64;

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

/**
 * Validates a worktree name: total length ≤64; each "/"-separated segment is
 * non-empty and matches [A-Za-z0-9._-]; rejects "." / ".." segments.
 * Throws with a caller-facing message on failure.
 */
export function validateWorktreeName(name: string): void {
  if (name.length > MAX_WORKTREE_SLUG_LENGTH) {
    throw new Error(
      `Invalid worktree name: must be ${MAX_WORKTREE_SLUG_LENGTH} characters or fewer (got ${name.length})`,
    );
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
    if (!VALID_WORKTREE_SLUG_SEGMENT.test(segment)) {
      throw new Error(
        `Invalid worktree name "${name}": each "/"-separated segment must be non-empty and contain only letters, digits, dots, underscores, and dashes`,
      );
    }
  }
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
    userFacingName(input) {
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
      if (isMainAgentContext(ctx)) setTrackedCwd(result.worktreePath);
      return ok(call.id, result.message);
    } catch (e) {
      return err(call.id, e instanceof Error ? e.message : String(e));
    }
  },
};
