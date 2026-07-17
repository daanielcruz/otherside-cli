import { recordCodexRawReplayDiagnostic } from "@/devtools/codex-raw-stream.ts";
import {
  dispatchFork,
  dispatchSubagent,
  type SubagentResult,
} from "@/engine/background/subagents/dispatcher.ts";
import {
  isMainAgentContext,
  nestedForkUnavailableMessage,
} from "@/engine/background/subagents/fork/spawn-depth.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import { AgentSchema } from "@/engine/tools/dynamic/Agent.ts";
import { parseAgentInput } from "@/engine/tools/dynamic/agent-options.ts";
import { isAgentAutoBackgroundEnabled } from "@/kernel/config/agent-auto-background.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const FORK_OVERRIDE_REJECTION =
  "InputValidationError: `tier` and `provider` are not allowed with a fork. A fork inherits the parent model and provider — drop the override, or name a non-fork `subagent_type`.";

function stripUnsupportedAgentCwd(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input) || !("cwd" in input)) {
    return input;
  }
  const { cwd: _cwd, ...rest } = input as Record<string, unknown>;
  return rest;
}

function formatAgentResultContent(result: SubagentResult): string {
  let content = result.output;
  if (result.worktreePath) {
    const statusSuffix = result.worktreeDeleted ? " removed (unchanged)" : "";
    const trailer = `worktree: ${result.worktreePath} (branch ${result.worktreeBranch})${statusSuffix}`;
    if (result.worktreeWarning) {
      if (content.length > 0 && !content.endsWith("\n")) {
        content += "\n";
      }
      content += `Warning: ${result.worktreeWarning}\n`;
    }
    if (content.length > 0 && !content.endsWith("\n")) {
      content += "\n";
    }
    content += trailer;
  }
  return content;
}

export const Agent: ToolHandler = {
  schema: {
    name: AgentSchema.name,
    description: AgentSchema.description,
    inputSchema: AgentSchema.inputSchema,
  },
  coerceInput: stripUnsupportedAgentCwd,
  isConcurrencySafe: true,
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    recordCodexRawReplayDiagnostic({
      event: "agent_run_start",
      toolCallId: call.id,
      input: call.input,
      sessionId: ctx.sessionId,
    });
    const {
      subagentType,
      description,
      prompt,
      runInBackground,
      tier,
      model,
      provider,
      name,
      isolation,
      validationError,
    } = parseAgentInput(call.input ?? {});
    if (validationError) {
      return {
        tool_use_id: call.id,
        content: `InputValidationError: ${validationError}`,
        is_error: true,
      };
    }
    if (!prompt) {
      return { tool_use_id: call.id, content: "missing `prompt`", is_error: true };
    }
    const orchestrationMode = ctx.orchestrationMode ?? "disabled";
    const orchestrationError =
      orchestrationMode === "disabled" && (provider !== undefined || tier !== undefined)
        ? "InputValidationError: `provider` and `tier` are unavailable when orchestration is disabled. Use `model` with the active provider."
        : orchestrationMode === "default" && tier !== undefined
          ? "InputValidationError: `tier` is unavailable in Default mode. Use concrete `provider` + `model` pins or omit overrides."
          : orchestrationMode === "feudalism" && (provider !== undefined || model !== undefined)
            ? "InputValidationError: concrete `provider`/`model` pins are unavailable in feudalism mode. Use `tier` routing instead."
            : undefined;
    if (orchestrationError !== undefined) {
      return { tool_use_id: call.id, content: orchestrationError, is_error: true };
    }
    // "remote" is accepted on the wire; this build has no cloud
    // runner, so it resolves to local worktree isolation.
    const effectiveIsolation = isolation === "remote" ? "worktree" : isolation;

    const effectiveBackground = runInBackground || isAgentAutoBackgroundEnabled();
    const forkId = ctx.childTaskIdMap?.get(call.id) ?? ctx.bgTaskId;

    if (subagentType !== null && subagentType.toLowerCase() === "fork") {
      if (!isMainAgentContext(ctx)) {
        return { tool_use_id: call.id, content: nestedForkUnavailableMessage, is_error: true };
      }
      if (tier || provider) {
        return { tool_use_id: call.id, content: FORK_OVERRIDE_REJECTION, is_error: true };
      }
      // `model` is silently ignored on a fork — it always inherits the parent model.
      const result = await dispatchFork(
        {
          directive: prompt,
          ...(description !== undefined ? { description } : {}),
          runInBackground: effectiveBackground,
          parentToolCallId: call.id,
          ...(forkId !== undefined ? { forkId } : {}),
          ...(name !== undefined ? { name } : {}),
          ...(effectiveIsolation !== undefined ? { isolation: effectiveIsolation } : {}),
        },
        ctx,
      );
      return {
        tool_use_id: call.id,
        content: formatAgentResultContent(result),
        ...(result.isError ? { is_error: true } : {}),
      };
    }

    recordCodexRawReplayDiagnostic({
      event: "agent_dispatch_start",
      toolCallId: call.id,
      subagentType: subagentType ?? "general-purpose",
      tier,
      model,
      provider,
      sessionId: ctx.sessionId,
    });
    const result = await dispatchSubagent(
      {
        subagentType: subagentType ?? "general-purpose",
        prompt,
        ...(description !== undefined ? { description } : {}),
        ...(name !== undefined ? { name } : {}),
        runInBackground: effectiveBackground,
        parentToolCallId: call.id,
        ...(forkId !== undefined ? { forkId } : {}),
        ...(tier !== undefined ? { tierOverride: tier } : {}),
        ...(model !== undefined ? { modelOverride: model } : {}),
        ...(provider !== undefined ? { providerOverride: provider } : {}),
        ...(effectiveIsolation !== undefined ? { isolation: effectiveIsolation } : {}),
      },
      ctx,
    );
    recordCodexRawReplayDiagnostic({
      event: "agent_dispatch_end",
      toolCallId: call.id,
      isError: result.isError === true,
      sessionId: ctx.sessionId,
    });
    return {
      tool_use_id: call.id,
      content: formatAgentResultContent(result),
      ...(result.isError ? { is_error: true } : {}),
    };
  },
};
