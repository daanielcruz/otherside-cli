import { partitionForConcurrency } from "@/engine/queue/runtime/concurrency.ts";
import { nowIso } from "@/engine/session/record/index.ts";
import {
  applyToolOutputBudget,
  archiveLargeToolOutput,
  isArchivedOutputNotice,
  outputArchiveThreshold,
} from "@/engine/tool-output-archive/index.ts";
import type { ProviderToolDeclaration } from "@/engine/translator/index.ts";
import type { HookHandler } from "@/kernel/hooks/index.ts";
import { AbortError, throwIfAborted } from "@/kernel/std/stream/abort.ts";
import type { ForkEventSink } from "@/kernel/std/types/events.ts";
import { type ContentBlock, type ToolCall, toolResultText } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  type CompiledSchema,
  type DispatchPlanItem,
  type ForkEmit,
  type ParentRef,
  type PlanItem,
  planForkToolCall,
} from "./dispatch-plan.ts";
import type { NestedCompletionGate } from "./nested-agent-control.ts";
import { toolInputObject } from "./tool-gates.ts";
import type { ForkSpec, SidechainRecord, SubagentResult } from "./types.ts";

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

type FinishFork = (
  event: Parameters<ForkEventSink>[0],
  result: SubagentResult,
) => Promise<SubagentResult>;

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
  // Durable pairing ledger: the caller persisted a tool_call record for every
  // call before dispatch, so any escape from this function must leave each of
  // them paired with a tool_result record — an unpaired tool_use poisons the
  // persisted transcript for resume and fails the session audit.
  const pairedCallIds = new Set<string>();
  const sealUnpairedToolCalls = (error: unknown): void => {
    const content =
      error instanceof AbortError
        ? "Interrupted by user"
        : error instanceof Error && error.message.length > 0
          ? error.message
          : "Tool dispatch aborted";
    for (const call of args.toolCalls) {
      if (pairedCallIds.has(call.id)) continue;
      args.appendSidechainRecord({
        type: "tool_result",
        ts: nowIso(),
        call_id: call.id,
        result: content,
        is_error: true,
      });
    }
  };
  try {
    for (const group of partitionForConcurrency(args.toolCalls)) {
      throwIfAborted(args.ctx.abortSignal);

      // Phase A: build a plan item per call, synchronously and in call order.
      const planItems: PlanItem[] = [];
      for (const call of group) {
        planItems.push(
          planForkToolCall({
            call,
            ctx: args.ctx,
            spec: args.spec,
            forkId: args.forkId,
            name: args.name,
            allowSet: args.allowSet,
            parentRef: args.parentRef,
            compiledSchema: args.compiledSchema,
            hookHandlers: args.hookHandlers,
            state,
            emit: args.emit,
          }),
        );
      }
      for (const item of planItems) {
        if (item.kind === "dispatch" && item.completionGate !== undefined) {
          taskCompletionGates.push(item.completionGate);
        }
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
          pairedCallIds.add(item.call.id);
          args.appendSidechainRecord({
            type: "tool_result",
            ts: nowIso(),
            call_id: item.call.id,
            result: item.resultBlock.content,
            is_error: item.resultBlock.is_error === true,
          });
          if (item.degenerateIsError !== null) trackDegenerate(item.call, item.degenerateIsError);
          continue;
        }
        const { call } = item;
        // Safe: settled has exactly one entry per dispatch plan item, in the
        // same order (Promise.allSettled preserves input array order/length).
        const outcome = settled[dispatchIdx] as PromiseSettledResult<
          Awaited<(typeof dispatchItems)[number]["promise"]>
        >;
        dispatchIdx += 1;
        if (outcome.status === "rejected") {
          if (firstRejection === undefined) firstRejection = { error: outcome.reason };
          continue;
        }
        const result = outcome.value;
        const toolResultBlock = await archiveLargeToolOutput(
          {
            type: "tool_result",
            tool_use_id: call.id,
            content: result.content,
            ...(result.is_error ? { is_error: true } : {}),
          },
          call.name,
          outputArchiveThreshold(call.name),
        );
        const wasPersisted =
          isArchivedOutputNotice(toolResultBlock.content) &&
          !isArchivedOutputNotice(result.content);
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
        pairedCallIds.add(call.id);
        args.appendSidechainRecord({
          type: "tool_result",
          ts: nowIso(),
          call_id: call.id,
          result: toolResultBlock.content,
          is_error: result.is_error === true,
        });
        trackDegenerate(call, result.is_error === true);
      }
      // Rejections have no dispatch result of their own. Seal their terminal
      // task state before propagating, while the generation guards still
      // prevent a cancellation race from overwriting a killed task; the catch
      // below pairs their persisted tool_call records.
      if (firstRejection !== undefined) {
        for (const gate of taskCompletionGates) gate.commit();
        throw firstRejection.error;
      }
    }
  } catch (error) {
    sealUnpairedToolCalls(error);
    throw error;
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

export async function applyForkToolResultBudget(
  fork: Parameters<typeof applyToolOutputBudget>[0],
  ctx: RequestContext,
  appendSidechainRecord: (record: SidechainRecord) => void,
): Promise<Parameters<typeof applyToolOutputBudget>[0]> {
  return applyToolOutputBudget(fork, ctx.toolOutputArchive, (records) => {
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
