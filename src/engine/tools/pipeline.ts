import { isAbsolute, resolve } from "node:path";
import { recordCodexRawReplayDiagnostic } from "@/devtools/codex-raw-stream.ts";
import { devtoolBoolean } from "@/devtools/settings.ts";
import { isWriteEscapingWorktree } from "@/engine/background/subagents/worktree.ts";
import { QuotaExhaustedError } from "@/engine/providers/_shared/retry.ts";
import { formatValidationError } from "@/engine/tools/_infra/format.ts";
import { validateToolInput } from "@/engine/tools/_infra/validate.ts";
import { appendPostToolUseFeedback } from "@/kernel/hooks/handler.ts";
import type { HookHandler } from "@/kernel/hooks/index.ts";
import { isMcpToolName } from "@/kernel/mcp/index.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext, ScopedToolHandler } from "@/kernel/std/types/request.ts";
import { schemaNotSentHint } from "./deferred.ts";
import { runWithPermissionAbortSignal } from "./permission-abort-context.ts";
import {
  type PreToolUseHookPermissionSignal,
  runWithPreToolUseHookPermissionSignal,
} from "./pretooluse-hook-permission-context.ts";
import * as registry from "./registry.ts";

export type PermissionDecision = "allow" | "deny" | "ask" | { kind: "deny"; message: string };

export interface PipelineDeps {
  permission: (call: ToolCall, ctx: RequestContext) => Promise<PermissionDecision>;
  hooks: HookHandler[];
}

type Verdict = { kind: "allow" } | { kind: "deny"; message: string };

type PreToolUseHookOutcome = Awaited<ReturnType<NonNullable<HookHandler["preToolUse"]>>>;

function isBlockedByHook(
  out: PreToolUseHookOutcome,
): out is "block" | { kind: "block"; reason: string } {
  return out === "block" || (typeof out === "object" && "kind" in out && out.kind === "block");
}

// Unwraps a non-blocking PreToolUse outcome into the (possibly rewritten)
// call plus whichever explicit permissionDecision ("allow" | "ask") a hook
// asserted for it, if any -- a bare `ToolCall` (no `kind` tag) is the
// pre-existing decision-less passthrough and carries no permission signal.
function unwrapPreToolUseOutcome(
  out: Exclude<PreToolUseHookOutcome, "block" | { kind: "block"; reason: string }>,
): { call: ToolCall; permission: PreToolUseHookPermissionSignal } {
  if (typeof out === "object" && "kind" in out && (out.kind === "allow" || out.kind === "ask")) {
    return { call: out.call, permission: out.kind };
  }
  return { call: out, permission: undefined };
}

// "ask" outranks an explicit "allow" across hooks in the chain, mirroring the
// same precedence `preToolUseDecisionFromOutcomes` applies within a single
// HookHandler's own aggregation -- a later hook's plain allow never
// downgrades an earlier hook's forced ask.
function combineHookPermission(
  a: PreToolUseHookPermissionSignal,
  b: PreToolUseHookPermissionSignal,
): PreToolUseHookPermissionSignal {
  return a === "ask" || b === "ask" ? "ask" : (a ?? b);
}

function handlerFor(callName: string, ctx: RequestContext): ScopedToolHandler | undefined {
  return ctx.scopedToolHandlers?.get(callName) ?? registry.get(callName);
}

async function decide(call: ToolCall, ctx: RequestContext, deps: PipelineDeps): Promise<Verdict> {
  const d = await deps.permission(call, ctx);
  if (d === "deny") return { kind: "deny", message: "permission denied" };
  if (typeof d === "object" && d.kind === "deny") return d;
  return { kind: "allow" };
}

function inputValidationFailure(
  call: ToolCall,
  rawInput: unknown,
  ctx: RequestContext,
): ToolResult | null {
  if (isMcpToolName(call.name)) return null;
  const handler = handlerFor(call.name, ctx);
  if (!handler) return null;
  const issues = validateToolInput(handler.schema.inputSchema, call.input);
  if (issues.length === 0) return null;
  const steer = handler.steerValidationError?.(rawInput);
  const hint = ctx.scopedToolHandlers?.has(call.name)
    ? ""
    : (schemaNotSentHint(call.name, ctx.agentOwnerId) ?? "");
  const errorContent = steer ?? `${formatValidationError(handler.schema.name, issues)}${hint}`;
  return {
    tool_use_id: call.id,
    content: `<tool_use_error>InputValidationError: ${errorContent}</tool_use_error>`,
    is_error: true,
  };
}

function coerceCallInput(call: ToolCall, ctx: RequestContext): ToolCall {
  const handler = handlerFor(call.name, ctx);
  if (!handler?.coerceInput) return call;
  const coerced = handler.coerceInput(call.input);
  if (coerced === call.input) return call;
  return { ...call, input: coerced };
}

// Input-shape validation and worktree-escape checks are pre-hook preconditions,
// not permission decisions: they gate whether the call is even eligible to run
// through PreToolUse hooks, and are only evaluated once,
// against the model-authored input.
async function validatePreconditions(
  call: ToolCall,
  rawInput: unknown,
  ctx: RequestContext,
): Promise<ToolResult | null> {
  const invalid = inputValidationFailure(call, rawInput, ctx);
  if (invalid) return invalid;

  if (ctx.worktreeRoot) {
    let targetPath: unknown;
    if (call.input && typeof call.input === "object") {
      const input = call.input as Record<string, unknown>;
      if (call.name === "Edit" || call.name === "Write") {
        targetPath = input.file_path;
      } else if (call.name === "NotebookEdit") {
        targetPath = input.notebook_path;
      }
    }
    if (typeof targetPath === "string") {
      const resolvedPath = isAbsolute(targetPath) ? targetPath : resolve(ctx.cwd, targetPath);
      if (await isWriteEscapingWorktree(resolvedPath, ctx.worktreeRoot)) {
        return {
          tool_use_id: call.id,
          content: `This session is isolated in ${ctx.worktreeRoot}. Edit the worktree copy of this file instead of the shared-checkout path.`,
          is_error: true,
        };
      }
    }
  }

  return null;
}

// Permission is resolved exactly once, after PreToolUse hooks have had a
// chance to rewrite the call. Hooks run before the user is
// ever asked for permission, and the permission/explicit deny-ask rules are
// evaluated against the final, hook-updated input. `hookPermission` carries
// any explicit permissionDecision the hook chain asserted ("allow" | "ask"),
// threaded through to permission resolution via AsyncLocalStorage so it can
// bypass or force the interactive/headless prompt (PERM-HOOK-ALLOW-BYPASS-001).
async function resolvePermissionDecision(
  call: ToolCall,
  ctx: RequestContext,
  deps: PipelineDeps,
  hookPermission: PreToolUseHookPermissionSignal,
): Promise<ToolResult | null> {
  const verdict = await runWithPermissionAbortSignal(ctx.abortSignal, () =>
    runWithPreToolUseHookPermissionSignal(hookPermission, () => decide(call, ctx, deps)),
  );
  if (verdict.kind === "deny") {
    return { tool_use_id: call.id, content: verdict.message, is_error: true };
  }
  // Permission can resolve at the same time as turn cancellation. Never let an
  // approval that lost that race reach a mutating tool handler.
  if (ctx.abortSignal?.aborted) {
    return { tool_use_id: call.id, content: "Interrupted by user", is_error: true };
  }
  return null;
}

export async function dispatch(
  rawCall: ToolCall,
  ctx: RequestContext,
  deps: PipelineDeps,
): Promise<ToolResult> {
  recordCodexRawReplayDiagnostic({
    event: "tool_dispatch_enter",
    toolCallId: rawCall.id,
    toolName: rawCall.name,
    sessionId: ctx.sessionId,
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
  });
  if (
    devtoolBoolean("codexRawStreamReplayNoopTools") &&
    rawCall.name !== "Agent" &&
    rawCall.name !== "Workflow" &&
    rawCall.name !== "ToolSearch"
  ) {
    return {
      tool_use_id: rawCall.id,
      content: "Raw stream replay suppressed tool execution.",
    };
  }
  const call = coerceCallInput(rawCall, ctx);
  const preconditionFailure = await validatePreconditions(call, rawCall.input, ctx);
  if (preconditionFailure) return preconditionFailure;

  let current = call;
  let hookPermission: PreToolUseHookPermissionSignal;
  for (const h of deps.hooks) {
    if (!h.preToolUse) continue;
    try {
      const out = await h.preToolUse(current, ctx);
      if (isBlockedByHook(out)) {
        return {
          tool_use_id: call.id,
          content: out === "block" ? "blocked by hook" : out.reason,
          is_error: true,
        };
      }
      const unwrapped = unwrapPreToolUseOutcome(out);
      current = unwrapped.call;
      hookPermission = combineHookPermission(hookPermission, unwrapped.permission);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? "unknown error");
      return {
        tool_use_id: call.id,
        content: `preToolUse hook threw: ${message}`,
        is_error: true,
      };
    }
  }
  current = coerceCallInput(current, ctx);

  // Permission is asked exactly once, after hooks have had their say, so a
  // hook that blocks or rewrites the call is honored before the user is ever
  // prompted.
  const permissionFailure = await resolvePermissionDecision(current, ctx, deps, hookPermission);
  if (permissionFailure) return permissionFailure;

  const handler = handlerFor(current.name, ctx);
  if (!handler) {
    return {
      tool_use_id: call.id,
      content: `unknown tool: ${current.name}`,
      is_error: true,
    };
  }

  let result: ToolResult;
  try {
    result = await handler.run(current, ctx);
  } catch (err) {
    if (err instanceof QuotaExhaustedError) throw err;
    const message = err instanceof Error ? err.message : String(err ?? "unknown error");
    result = {
      tool_use_id: call.id,
      content: `${current.name} threw: ${message}`,
      is_error: true,
    };
  }
  for (const h of deps.hooks) {
    if (!h.postToolUse) continue;
    try {
      result = await h.postToolUse(current, result, ctx);
    } catch (err) {
      // A postToolUse handler that throws is a hook-side failure, not a tool
      // failure: the tool already ran and produced `result`. Keep that result
      // authoritative and surface the exception as separate hook feedback,
      // rather than discarding the tool's actual output.
      const message = err instanceof Error ? err.message : String(err ?? "unknown error");
      result = appendPostToolUseFeedback(result, [`postToolUse hook threw: ${message}`]);
    }
  }
  recordCodexRawReplayDiagnostic({
    event: "tool_result",
    toolCallId: current.id,
    toolName: current.name,
    input: current.input,
    result,
    sessionId: ctx.sessionId,
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
  });
  return result;
}
