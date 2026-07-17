import {
  getAgentContext,
  getPermissionResolver,
  MAX_AGENT_SPAWN_DEPTH,
  runWithAgentContext,
} from "@/engine/agents/agent-context.ts";
import { get as getAgentDef } from "@/engine/agents/registry.ts";
import {
  cancelTaskTree as bgCancelTaskTree,
  completeTaskForRun as bgCompleteTaskForRun,
  detachTaskForRun as bgDetachTaskForRun,
  setForkId as bgSetForkId,
  startTask as bgStartTask,
  type TaskCompletion,
  type TaskRunRef,
  taskRunRef,
} from "@/engine/background/tasks/background.ts";
import * as bgControllers from "@/engine/background/tasks/background-controllers.ts";
import { buildAgentLaunchReceipt } from "@/engine/background/tasks/notification.ts";
import { ensureChildTaskIdMap } from "@/engine/background/tasks/progress.ts";
import { cloneWorkflowBoundaryValue } from "@/engine/background/workflows/runtime/sandbox/clone.ts";
import { partitionForConcurrency } from "@/engine/queue/runtime/concurrency.ts";
import { nowIso } from "@/engine/session/record/index.ts";
import {
  applyToolResultBudget,
  getPersistenceThreshold,
  isPersistedOutputWrapper,
  maybePersistLargeToolResult,
} from "@/engine/tool-result-storage/index.ts";
import { activeDeferredToolNames } from "@/engine/tools/deferred.ts";
import { isForkDisallowedTool } from "@/engine/tools/fork-disallowed.ts";
import { dispatch as dispatchTool } from "@/engine/tools/pipeline.ts";
import type { ProviderToolDeclaration } from "@/engine/translator/index.ts";
import {
  type ProviderToolDescriptionOptions,
  providerToolDescription,
} from "@/engine/translator/tools.ts";
import type { HookHandler } from "@/kernel/hooks/index.ts";
import { AbortError, isAbortError, linkAbort, throwIfAborted } from "@/kernel/std/stream/abort.ts";
import type { BackgroundController, ForkEventSink } from "@/kernel/std/types/events.ts";
import {
  type ContentBlock,
  type ToolCall,
  type ToolResult,
  toolResultText,
} from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import type { compileOutputSchema } from "../structured-output.ts";
import { STRUCTURED_OUTPUT_SUCCESS, STRUCTURED_OUTPUT_TOOL_NAME } from "../structured-output.ts";
import {
  agentSpawnDepth,
  agentSpawnDepthFromContext,
  subagentNestingLimitMessage,
} from "./spawn-depth.ts";
import type { ForkSpec, SidechainRecord, SubagentResult } from "./types.ts";

// Skill spawns a nested skill fork, so it shares Agent's depth ceiling.
const SPAWNABLE_NESTED_TOOLS = new Set(["Agent", "Skill"]);
const TOOL_REQUIRED_FIELD: Record<string, string> = {
  Bash: "command",
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  Grep: "pattern",
  Glob: "pattern",
  WebFetch: "url",
  WebSearch: "query",
};

type ParentRef = { parentToolCallId?: string };
type ForkEmit = (event: Parameters<ForkEventSink>[0]) => void;
type FinishFork = (
  event: Parameters<ForkEventSink>[0],
  result: SubagentResult,
) => Promise<SubagentResult>;
type CompiledSchema = Exclude<ReturnType<typeof compileOutputSchema>, { kind: "invalid" }>;

export interface ForkToolDispatchState {
  degenerateToolCalls: number;
  lastFailingSignature: string | null;
  structuredOutputRetries: number;
  lastStructuredError: string | null;
  structuredValue: unknown;
  structuredOutputConsumed: boolean;
}

export type ForkToolDispatchOutcome =
  | { kind: "finished"; result: SubagentResult }
  | {
      kind: "ready";
      results: ContentBlock[];
      state: ForkToolDispatchState;
      commitTaskCompletions: () => void;
    };

// A plan item captures the per-call work computed synchronously in Phase A so
// Phase C can push results/track degeneracy in original call order, regardless
// of which concurrency-safe dispatch settles first.
type ImmediatePlanItem = {
  kind: "immediate";
  call: ToolCall;
  resultBlock: ContentBlock;
  // null skips the trackDegenerate call entirely — matches today's quirk where
  // a structured-output schema mismatch does not count as a degenerate call.
  degenerateIsError: boolean | null;
};
type DispatchPlanItem = {
  kind: "dispatch";
  call: ToolCall;
  nestedRun: TaskRunRef | undefined;
  promise: ReturnType<typeof dispatchToolWithAgentContext>;
  taskCompletionPromise?: Promise<ToolResult>;
  completionGate?: NestedCompletionGate;
};
type PlanItem = ImmediatePlanItem | DispatchPlanItem;

export async function dispatchForkToolCalls(args: {
  toolCalls: ToolCall[];
  ctx: RequestContext;
  spec: ForkSpec;
  forkId: string;
  name: string;
  allowSet: Set<string> | null;
  parentRef: ParentRef;
  compiledSchema: CompiledSchema | null;
  hookHandlers: HookHandler[];
  state: ForkToolDispatchState;
  emit: ForkEmit;
  finish: FinishFork;
  appendSidechainRecord: (record: SidechainRecord) => void;
}): Promise<ForkToolDispatchOutcome> {
  const state = { ...args.state };
  const trackDegenerate = (call: ToolCall, isError: boolean): void => {
    if (!isError) {
      state.degenerateToolCalls = 0;
      state.lastFailingSignature = null;
      return;
    }
    const signature = callSignature(call);
    if (hasMissingRequiredField(call) || signature === state.lastFailingSignature) {
      state.degenerateToolCalls += 1;
    } else {
      state.degenerateToolCalls = 1;
    }
    state.lastFailingSignature = signature;
  };

  const results: ContentBlock[] = [];
  const taskCompletionGates: NestedCompletionGate[] = [];
  for (const group of partitionForConcurrency(args.toolCalls)) {
    throwIfAborted(args.ctx.abortSignal);

    // Phase A: build a plan item per call, synchronously and in call order.
    // Dispatchable calls START their promise here (rather than awaiting it)
    // so all nested Agent panel registrations happen before any sibling in
    // the group resolves — that ordering is the actual fix.
    const planItems: PlanItem[] = [];
    for (const call of group) {
      const agentTypeDenied = deniedNestedAgentType(call, args.spec.allowedAgentTypes);
      if (agentTypeDenied) {
        planItems.push(deniedPlanItem(args, call, agentTypeDenied));
        continue;
      }
      if (
        SPAWNABLE_NESTED_TOOLS.has(call.name) &&
        agentSpawnDepth(args.ctx) >= MAX_AGENT_SPAWN_DEPTH
      ) {
        planItems.push(
          deniedPlanItem(args, call, subagentNestingLimitMessage(agentSpawnDepth(args.ctx))),
        );
        continue;
      }
      if (call.name === STRUCTURED_OUTPUT_TOOL_NAME) {
        if (args.compiledSchema === null) {
          planItems.push(
            deniedPlanItem(args, call, `tool ${STRUCTURED_OUTPUT_TOOL_NAME} not allowed`),
          );
          continue;
        }
        const validation = args.compiledSchema.validate(call.input);
        if (validation.kind === "mismatch") {
          state.structuredOutputRetries += 1;
          state.lastStructuredError = validation.error;
          args.emit({
            kind: "fork_tool_dispatch_complete",
            forkId: args.forkId,
            toolCallId: call.id,
            toolName: call.name,
            content: validation.error,
            isError: true,
            ...args.parentRef,
          });
          planItems.push({
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
          });
          continue;
        }
        state.structuredValue = cloneWorkflowBoundaryValue(call.input);
        args.emit({
          kind: "fork_tool_dispatch_complete",
          forkId: args.forkId,
          toolCallId: call.id,
          toolName: call.name,
          content: STRUCTURED_OUTPUT_SUCCESS,
          isError: false,
          ...args.parentRef,
        });
        planItems.push({
          kind: "immediate",
          call,
          resultBlock: {
            type: "tool_result",
            tool_use_id: call.id,
            content: STRUCTURED_OUTPUT_SUCCESS,
          },
          degenerateIsError: false,
        });
        state.structuredOutputConsumed = true;
        continue;
      }
      if (
        !isDispatchableForkTool(call.name, args.allowSet, {
          ...(args.spec.permissionMode !== undefined
            ? { permissionMode: args.spec.permissionMode }
            : {}),
          ownerScope: args.ctx.agentOwnerId,
        })
      ) {
        planItems.push(
          deniedPlanItem(args, call, `tool ${call.name} not allowed for ${args.name}`),
        );
        continue;
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
        const description =
          typeof inputObj.description === "string" ? inputObj.description : undefined;
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
      if (completionGate !== undefined) taskCompletionGates.push(completionGate);
      planItems.push({
        kind: "dispatch",
        call,
        nestedRun,
        promise,
        ...(taskCompletionPromise ? { taskCompletionPromise } : {}),
        ...(completionGate ? { completionGate } : {}),
      });
    }

    // Phase B: run every dispatchable call of the group concurrently.
    const dispatchItems = planItems.filter(
      (item): item is DispatchPlanItem => item.kind === "dispatch",
    );
    const settled = await Promise.allSettled(dispatchItems.map((item) => item.promise));

    // Phase C: process in original call order so `results` and trackDegenerate
    // stay call-ordered regardless of settle order.
    let dispatchIdx = 0;
    let firstRejection: { error: unknown } | undefined;
    for (const item of planItems) {
      if (item.kind === "immediate") {
        results.push(item.resultBlock);
        if (item.degenerateIsError !== null) trackDegenerate(item.call, item.degenerateIsError);
        continue;
      }
      const { call } = item;
      // Safe: settled has exactly one entry per dispatch plan item, in the
      // same order (Promise.allSettled preserves input array order/length).
      const outcome = settled[dispatchIdx] as PromiseSettledResult<
        Awaited<ReturnType<typeof dispatchToolWithAgentContext>>
      >;
      dispatchIdx += 1;
      if (outcome.status === "rejected") {
        if (firstRejection === undefined) firstRejection = { error: outcome.reason };
        continue;
      }
      const result = outcome.value;
      const toolResultBlock = await maybePersistLargeToolResult(
        {
          type: "tool_result",
          tool_use_id: call.id,
          content: result.content,
          ...(result.is_error ? { is_error: true } : {}),
        },
        call.name,
        getPersistenceThreshold(call.name),
      );
      const wasPersisted =
        isPersistedOutputWrapper(toolResultBlock.content) &&
        !isPersistedOutputWrapper(result.content);
      args.emit({
        kind: "fork_tool_dispatch_complete",
        forkId: args.forkId,
        toolCallId: call.id,
        toolName: call.name,
        content: toolResultText(toolResultBlock.content),
        ...(wasPersisted ? { displayContent: toolResultText(result.content) } : {}),
        isError: result.is_error === true,
        ...args.parentRef,
      });
      results.push(toolResultBlock);
      args.appendSidechainRecord({
        type: "tool_result",
        ts: nowIso(),
        call_id: call.id,
        result: toolResultBlock.content,
        is_error: result.is_error === true,
      });
      trackDegenerate(call, result.is_error === true);
    }
    // Rejections have no tool-result insertion point. Seal their terminal task
    // state before propagating, while the generation guards still prevent a
    // cancellation race from overwriting a killed task.
    if (firstRejection !== undefined) {
      for (const gate of taskCompletionGates) gate.commit();
      throw firstRejection.error;
    }
  }

  return {
    kind: "ready",
    results,
    state,
    commitTaskCompletions: () => {
      for (const gate of taskCompletionGates) gate.commit();
    },
  };
}

interface NestedControllerRegistration {
  controller: BackgroundController;
  abortController: AbortController;
  release: () => void;
}

function createNestedBackgroundController(
  callId: string,
  run: TaskRunRef,
  parentSignal: AbortSignal | undefined,
): NestedControllerRegistration {
  let backgrounded = false;
  let resolve: (() => void) | undefined;
  let released = false;
  const abortController = new AbortController();
  const detachParentAbort = linkAbort(abortController, parentSignal);
  const signaled = new Promise<void>((done) => {
    resolve = done;
  });
  let releaseRegistration = (): void => {};
  const release = (): void => {
    if (released) return;
    released = true;
    detachParentAbort();
    releaseRegistration();
  };
  const controller: BackgroundController = {
    signal: () => {
      if (backgrounded) return;
      backgrounded = true;
      detachParentAbort();
      bgDetachTaskForRun(run);
      resolve?.();
    },
    isBackgrounded: () => backgrounded,
    abort: () => abortController.abort(new AbortError()),
    taskId: run.taskId,
    signaled,
  };
  releaseRegistration = bgControllers.register(callId, controller);
  return { controller, abortController, release };
}

interface NestedCompletionGate {
  commit: () => void;
}

function createNestedCompletionGate(
  run: TaskRunRef,
  completion: Promise<ToolResult>,
): NestedCompletionGate {
  let committed = false;
  let settled: TaskCompletion | undefined;
  const publish = (): void => {
    if (settled === undefined || !committed) return;
    bgCompleteTaskForRun(run, settled);
  };
  void completion.then(
    (result) => {
      settled = {
        content: toolResultText(result.content),
        isError: result.is_error === true,
      };
      publish();
    },
    (reason: unknown) => {
      if (isAbortError(reason)) {
        bgCancelTaskTree(run, {
          reason: reason instanceof Error ? reason.message : "aborted",
          suppressRootNotification: true,
        });
        return;
      }
      settled = {
        content: reason instanceof Error ? reason.message : String(reason),
        isError: true,
      };
      publish();
    },
  );
  return {
    commit: () => {
      if (committed) return;
      committed = true;
      publish();
    },
  };
}

function detachNestedAgent(
  dispatched: Promise<ToolResult>,
  controller: BackgroundController,
  taskId: string | undefined,
  toolUseId: string,
): Promise<ToolResult> {
  return Promise.race([
    dispatched,
    controller.signaled!.then(() => ({
      tool_use_id: toolUseId,
      content: buildAgentLaunchReceipt(taskId ?? "unknown"),
    })),
  ]);
}

function deniedPlanItem(
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

export async function applyForkToolResultBudget(
  fork: Parameters<typeof applyToolResultBudget>[0],
  ctx: RequestContext,
  appendSidechainRecord: (record: SidechainRecord) => void,
): Promise<Parameters<typeof applyToolResultBudget>[0]> {
  return applyToolResultBudget(fork, ctx.contentReplacementState, (records) => {
    for (const record of records) {
      appendSidechainRecord({
        type: "content_replacement",
        ts: nowIso(),
        kind: record.kind,
        toolUseId: record.toolUseId,
        replacement: record.replacement,
      });
    }
  });
}

export function forkToolDescription(
  name: string,
  description: string,
  opts: Omit<ProviderToolDescriptionOptions, "mainAgent">,
): string {
  return providerToolDescription({ name, description }, { ...opts, mainAgent: false });
}

// Dispatch gate: a tool outside the allow set is dispatchable only when THIS
// agent loaded it through its own ToolSearch call — announcements from the
// main session (or any other agent) never grant dispatch here.
export function isDispatchableForkTool(
  name: string,
  allowSet: Set<string> | null,
  opts: {
    permissionMode?: "default" | "accept-edits" | "plan" | "yolo";
    ownerScope: string | undefined;
  },
): boolean {
  if (isForkDisallowedTool(name, opts.permissionMode)) return false;
  if (allowSet === null || allowSet.has(name)) return true;
  return allowSet.has("ToolSearch") && activeDeferredToolNames(opts.ownerScope).includes(name);
}

export function isAllowedInForkDeclarations(
  name: string,
  allowSet: Set<string> | null,
  spec: ForkSpec,
  ownerScope?: string,
): boolean {
  if (isForkDisallowedTool(name, spec.permissionMode)) return false;
  if (name === "Agent" && !spec.allowNestedAgents) return false;
  if (SPAWNABLE_NESTED_TOOLS.has(name)) {
    return (
      agentSpawnDepthFromContext() < MAX_AGENT_SPAWN_DEPTH &&
      (allowSet === null || allowSet.has(name))
    );
  }
  return (
    allowSet === null ||
    allowSet.has(name) ||
    (spec.deferredAllow?.has(name) ? activeDeferredToolNames(ownerScope).includes(name) : false)
  );
}

function deniedNestedAgentType(
  call: ToolCall,
  allowedAgentTypes: string[] | undefined,
): string | null {
  if (call.name !== "Agent" || allowedAgentTypes === undefined) return null;
  const input = toolInputObject(call.input);
  const raw = input.subagent_type;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const requested = raw.trim();
  if (allowedAgentTypes.includes(requested)) return null;
  return `agent ${requested} not allowed for nested Agent call; allowed: ${allowedAgentTypes.join(", ")}`;
}

function dispatchToolWithAgentContext(
  call: ToolCall,
  ctx: RequestContext,
  deps: Parameters<typeof dispatchTool>[2],
): ReturnType<typeof dispatchTool> {
  if (call.name !== "Agent" || getAgentContext() !== undefined)
    return dispatchTool(call, ctx, deps);
  const context = {
    agentId: ctx.agentOwnerId ?? ctx.sessionId,
    subagentName: ctx.subagentLabel ?? "subagent",
    depth: agentSpawnDepth(ctx),
    parentSessionId: ctx.parentThreadId ?? ctx.sessionId,
    agentType: "subagent" as const,
    sessionAllowedToolPatterns: new Set<string>(),
  };
  return runWithAgentContext(context, () => dispatchTool(call, ctx, deps));
}

function toolInputObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function hasMissingRequiredField(call: ToolCall): boolean {
  const field = TOOL_REQUIRED_FIELD[call.name];
  if (!field) return Object.keys(toolInputObject(call.input)).length === 0;
  const value = toolInputObject(call.input)[field];
  if (typeof value === "string") return value.trim().length === 0;
  return value === undefined || value === null;
}

function callSignature(call: ToolCall): string {
  return `${call.name}:${JSON.stringify(call.input ?? {})}`;
}

export type { ProviderToolDeclaration };
