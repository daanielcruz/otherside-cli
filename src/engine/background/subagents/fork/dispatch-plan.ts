import {
  currentSpawnedAgentScope,
  getPermissionResolver,
  MAX_AGENT_SPAWN_DEPTH,
  withSpawnedAgentScope,
} from "@/engine/agents/agent-context.ts";
import { get as getAgentDef } from "@/engine/agents/registry.ts";
import type { compileOutputSchema } from "@/engine/background/subagents/structured-output.ts";
import {
  STRUCTURED_OUTPUT_SUCCESS,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from "@/engine/background/subagents/structured-output.ts";
import {
  setForkId as bgSetForkId,
  startTask as bgStartTask,
  type TaskRunRef,
  taskRunRef,
} from "@/engine/background/tasks/background.ts";
import { ensureChildTaskIdMap } from "@/engine/background/tasks/progress.ts";
import { cloneWorkflowBoundaryValue } from "@/engine/background/workflows/runtime/sandbox/clone.ts";
import { dispatch as dispatchTool } from "@/engine/tools/pipeline.ts";
import type { HookHandler } from "@/kernel/hooks/index.ts";
import type { ForkEventSink } from "@/kernel/std/types/events.ts";
import type { ContentBlock, ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  createNestedBackgroundController,
  createNestedCompletionGate,
  detachNestedAgent,
  type NestedCompletionGate,
} from "./nested-agent-control.ts";
import { agentSpawnDepth, subagentNestingLimitMessage } from "./spawn-depth.ts";
import {
  deniedNestedAgentType,
  isDispatchableForkTool,
  SPAWNABLE_NESTED_TOOLS,
} from "./tool-gates.ts";
import type { ForkSpec } from "./types.ts";

export type ParentRef = { parentToolCallId?: string };
export type ForkEmit = (event: Parameters<ForkEventSink>[0]) => void;
export type CompiledSchema = Exclude<ReturnType<typeof compileOutputSchema>, { kind: "invalid" }>;

// A plan item captures the per-call work computed synchronously in Phase A so
// the settlement phase can push results/track degeneracy in original call
// order, regardless of which concurrency-safe dispatch settles first.
export type ToolResultContentBlock = Extract<ContentBlock, { type: "tool_result" }>;

export type ImmediatePlanItem = {
  kind: "immediate";
  call: ToolCall;
  resultBlock: ToolResultContentBlock;
  // null skips the trackDegenerate call entirely — matches today's quirk where
  // a structured-output schema mismatch does not count as a degenerate call.
  degenerateIsError: boolean | null;
};
export type DispatchPlanItem = {
  kind: "dispatch";
  call: ToolCall;
  nestedRun: TaskRunRef | undefined;
  promise: ReturnType<typeof dispatchToolWithAgentContext>;
  taskCompletionPromise?: Promise<ToolResult>;
  completionGate?: NestedCompletionGate;
};
export type PlanItem = ImmediatePlanItem | DispatchPlanItem;

/** The structured-output fields of the dispatch state the plan step mutates. */
export interface StructuredPlanState {
  structuredOutputRetries: number;
  lastStructuredError: string | null;
  structuredValue: unknown;
  structuredOutputConsumed: boolean;
}

export function deniedPlanItem(
  args: {
    forkId: string;
    parentRef: ParentRef;
    emit: ForkEmit;
  },
  call: ToolCall,
  content: string,
): ImmediatePlanItem {
  args.emit({
    kind: "fork_tool_dispatch_complete",
    forkId: args.forkId,
    toolCallId: call.id,
    toolName: call.name,
    content,
    isError: true,
    ...args.parentRef,
  });
  return {
    kind: "immediate",
    call,
    resultBlock: {
      type: "tool_result",
      tool_use_id: call.id,
      content,
      is_error: true,
    },
    degenerateIsError: true,
  };
}

/**
 * Phase A for one call: decide the plan item synchronously. Dispatchable calls
 * START their promise here (rather than awaiting it) so all nested Agent panel
 * registrations happen before any sibling in the group resolves — that ordering
 * is the actual fix.
 */
export function planForkToolCall(args: {
  call: ToolCall;
  ctx: RequestContext;
  spec: ForkSpec;
  forkId: string;
  name: string;
  allowSet: Set<string> | null;
  parentRef: ParentRef;
  compiledSchema: CompiledSchema | null;
  hookHandlers: HookHandler[];
  state: StructuredPlanState;
  emit: ForkEmit;
}): PlanItem {
  const { call } = args;
  const agentTypeDenied = deniedNestedAgentType(call, args.spec.allowedAgentTypes);
  if (agentTypeDenied) {
    return deniedPlanItem(args, call, agentTypeDenied);
  }
  if (SPAWNABLE_NESTED_TOOLS.has(call.name) && agentSpawnDepth(args.ctx) >= MAX_AGENT_SPAWN_DEPTH) {
    return deniedPlanItem(args, call, subagentNestingLimitMessage(agentSpawnDepth(args.ctx)));
  }
  if (call.name === STRUCTURED_OUTPUT_TOOL_NAME) {
    if (args.compiledSchema === null) {
      return deniedPlanItem(args, call, `tool ${STRUCTURED_OUTPUT_TOOL_NAME} not allowed`);
    }
    const validation = args.compiledSchema.validate(call.input);
    if (validation.kind === "mismatch") {
      args.state.structuredOutputRetries += 1;
      args.state.lastStructuredError = validation.error;
      args.emit({
        kind: "fork_tool_dispatch_complete",
        forkId: args.forkId,
        toolCallId: call.id,
        toolName: call.name,
        content: validation.error,
        isError: true,
        ...args.parentRef,
      });
      return {
        kind: "immediate",
        call,
        resultBlock: {
          type: "tool_result",
          tool_use_id: call.id,
          content: validation.error,
          is_error: true,
        },
        // today's code does not call trackDegenerate on a schema mismatch
        degenerateIsError: null,
      };
    }
    args.state.structuredValue = cloneWorkflowBoundaryValue(call.input);
    args.emit({
      kind: "fork_tool_dispatch_complete",
      forkId: args.forkId,
      toolCallId: call.id,
      toolName: call.name,
      content: STRUCTURED_OUTPUT_SUCCESS,
      isError: false,
      ...args.parentRef,
    });
    args.state.structuredOutputConsumed = true;
    return {
      kind: "immediate",
      call,
      resultBlock: {
        type: "tool_result",
        tool_use_id: call.id,
        content: STRUCTURED_OUTPUT_SUCCESS,
      },
      degenerateIsError: false,
    };
  }
  if (
    !isDispatchableForkTool(call.name, args.allowSet, {
      ...(args.spec.permissionMode !== undefined
        ? { permissionMode: args.spec.permissionMode }
        : {}),
      ownerScope: args.ctx.agentOwnerId,
    })
  ) {
    return deniedPlanItem(args, call, `tool ${call.name} not allowed for ${args.name}`);
  }
  args.emit({
    kind: "fork_tool_dispatch_start",
    forkId: args.forkId,
    toolCallId: call.id,
    toolName: call.name,
    input: call.input,
    ...args.parentRef,
  });
  let nestedRun: TaskRunRef | undefined;
  if (call.name === "Agent") {
    const inputObj = (call.input ?? {}) as {
      subagent_type?: unknown;
      description?: unknown;
      prompt?: unknown;
    };
    const slug =
      typeof inputObj.subagent_type === "string" ? inputObj.subagent_type : "general-purpose";
    const agentName = getAgentDef(slug)?.name ?? slug;
    const description = typeof inputObj.description === "string" ? inputObj.description : undefined;
    const prompt = typeof inputObj.prompt === "string" ? inputObj.prompt : undefined;
    const task = bgStartTask({
      parentToolCallId: call.id,
      parentTaskId: args.ctx.bgTaskId,
      spawnDepth: agentSpawnDepth(args.ctx) + 1,
      // Panel visibility is independent from cancellation linkage. Every
      // nested child begins foreground-linked and only signal() detaches it.
      isBackgrounded: true,
      lifecycleMode: "linked",
      ownerId: args.forkId,
      agentName,
      cwd: args.ctx.originalCwd ?? args.ctx.cwd,
      sessionId: args.ctx.sessionId,
      ...(description !== undefined ? { description } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
    });
    nestedRun = taskRunRef(task);
    // Nested Agent runs use the task id as forkId. Register before dispatch
    // so usage/tool events resolve to this row instead of collapsing onto
    // the depth-1 parent when the shared childTaskIdMap was missing.
    const childTaskIdMap = ensureChildTaskIdMap(args.ctx);
    childTaskIdMap.set(call.id, task.id);
    bgSetForkId(task.id, task.id);
  }
  const resolver = getPermissionResolver();
  const nestedRegistration =
    nestedRun === undefined
      ? undefined
      : createNestedBackgroundController(call.id, nestedRun, args.ctx.abortSignal);
  const nestedController = nestedRegistration?.controller;
  // Guard against a synchronous throw from dispatchToolWithAgentContext:
  // it must surface as a rejected promise, not escape Phase A directly,
  // or later calls in this group would never get their bookkeeping done.
  let promise: ReturnType<typeof dispatchToolWithAgentContext>;
  let taskCompletionPromise: Promise<ToolResult> | undefined;
  try {
    const nestedTaskId = nestedRun?.taskId;
    const dispatched = dispatchToolWithAgentContext(
      call,
      nestedRegistration && nestedTaskId !== undefined
        ? {
            ...args.ctx,
            abortSignal: nestedRegistration.abortController.signal,
            backgroundController: nestedRegistration.controller,
            // Pin the nested agent's own task id so its loop and any further
            // descendants inherit the correct bgTaskId even if map lookup fails.
            bgTaskId: nestedTaskId,
            childTaskIdMap: ensureChildTaskIdMap(args.ctx),
          }
        : args.ctx,
      {
        permission: resolver ?? (async () => "deny"),
        hooks: args.hookHandlers,
      },
    );
    taskCompletionPromise = nestedRegistration
      ? dispatched.finally(nestedRegistration.release)
      : undefined;
    promise = nestedController
      ? detachNestedAgent(taskCompletionPromise!, nestedController, nestedRun?.taskId, call.id)
      : dispatched;
  } catch (err) {
    nestedRegistration?.release();
    taskCompletionPromise = nestedRun === undefined ? undefined : Promise.reject(err);
    promise = taskCompletionPromise ?? Promise.reject(err);
  }
  const completionGate =
    nestedRun === undefined || nestedController === undefined
      ? undefined
      : createNestedCompletionGate(nestedRun, taskCompletionPromise ?? promise);
  return {
    kind: "dispatch",
    call,
    nestedRun,
    promise,
    ...(taskCompletionPromise ? { taskCompletionPromise } : {}),
    ...(completionGate ? { completionGate } : {}),
  };
}

function dispatchToolWithAgentContext(
  call: ToolCall,
  ctx: RequestContext,
  deps: Parameters<typeof dispatchTool>[2],
): ReturnType<typeof dispatchTool> {
  if (call.name !== "Agent" || currentSpawnedAgentScope() !== undefined)
    return dispatchTool(call, ctx, deps);
  const context = {
    agentId: ctx.agentOwnerId ?? ctx.sessionId,
    subagentName: ctx.subagentLabel ?? "subagent",
    depth: agentSpawnDepth(ctx),
    parentSessionId: ctx.parentThreadId ?? ctx.sessionId,
    agentType: "subagent" as const,
    sessionAllowedToolPatterns: new Set<string>(),
  };
  return withSpawnedAgentScope(context, () => dispatchTool(call, ctx, deps));
}
