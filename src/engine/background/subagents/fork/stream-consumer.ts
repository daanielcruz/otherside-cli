import type { UsageSnapshot } from "@/engine/session/compact/token-count.ts";
import { nowIso } from "@/engine/session/record/index.ts";
import { AbortError } from "@/kernel/std/stream/abort.ts";
import { isContentProgressEvent } from "@/kernel/std/stream/content-idle-timeout.ts";
import type { ForkEventSink, ProviderEvent } from "@/kernel/std/types/events.ts";
import type { ToolCall } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { iterateWithAbortSignal } from "./abort.ts";
import { MAX_FORK_STALL_RETRIES } from "./constants.ts";
import type { SidechainRecord, SubagentResult } from "./types.ts";

export type ForkStreamOutcome =
  | { kind: "retry"; consecutiveStalls: number }
  | { kind: "finished"; result: SubagentResult; consecutiveStalls: number }
  | {
      kind: "ready";
      consecutiveStalls: number;
      text: string;
      thinking: string;
      thinkingSignature: string;
      toolCalls: ToolCall[];
      stopReason: string;
      refusalExplanation: string | undefined;
      usage: UsageSnapshot;
    };

export async function consumeForkStream(args: {
  stream: AsyncIterable<ProviderEvent>;
  streamSignal: AbortSignal;
  ctx: RequestContext;
  forkId: string;
  parentRef: { parentToolCallId?: string };
  emit: (event: Parameters<ForkEventSink>[0]) => void;
  streamToolInputFor?: ReadonlySet<string> | undefined;
  finish: (event: Parameters<ForkEventSink>[0], result: SubagentResult) => Promise<SubagentResult>;
  armStallTimer: (label: string) => void;
  isStalled: () => boolean;
  stallMs: number;
  getLastStallLabel: () => string;
  getLastStallArmAt: () => number;
  consecutiveStalls: number;
  maxStallRetries?: number;
  turn: number;
  runStart: number;
  appendSidechainRecord: (record: SidechainRecord) => void;
  resetStall: () => void;
}): Promise<ForkStreamOutcome> {
  let text = "";
  let thinking = "";
  let thinkingSignature = "";
  const toolCalls: ToolCall[] = [];
  const streamedToolNames = new Map<string, string>();
  let stopReason = "stop";
  let refusalExplanation: string | undefined;
  const usage: UsageSnapshot = {
    inputTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  try {
    for await (const ev of iterateWithAbortSignal(args.stream, args.streamSignal)) {
      if (args.ctx.abortSignal?.aborted) throw new AbortError();
      if (isContentProgressEvent(ev)) {
        args.armStallTimer(`event:${ev.kind}`);
      }
      if (ev.kind === "text_delta") {
        text += ev.text;
        args.emit({
          kind: "fork_text_delta",
          forkId: args.forkId,
          text: ev.text,
          ...args.parentRef,
        });
      } else if (ev.kind === "thinking_delta") {
        thinking += ev.text;
      } else if (ev.kind === "thinking_signature") {
        thinkingSignature = ev.signature;
      } else if (ev.kind === "tool_call_start") {
        streamedToolNames.set(ev.id, ev.name);
      } else if (ev.kind === "tool_call_input_delta") {
        const toolName = streamedToolNames.get(ev.id);
        if (toolName && args.streamToolInputFor?.has(toolName)) {
          args.emit({
            kind: "fork_tool_input_delta",
            forkId: args.forkId,
            toolCallId: ev.id,
            toolName,
            partial: ev.partial,
            ...args.parentRef,
          });
        }
      } else if (ev.kind === "tool_call_complete") {
        streamedToolNames.delete(ev.id);
        toolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
      } else if (ev.kind === "message_stop") {
        stopReason = ev.stop_reason;
        if (ev.refusal !== undefined) refusalExplanation = ev.refusal;
      } else if (ev.kind === "usage") {
        updateUsage(usage, ev);
        emitUsageSnapshot(args, usage);
      } else if (ev.kind === "retry_status") {
        args.emit({
          kind: "fork_retry_status",
          forkId: args.forkId,
          attempt: ev.attempt,
          maxAttempts: ev.maxAttempts,
          delayMs: ev.delayMs,
          reason: ev.reason,
          ...args.parentRef,
        });
      } else if (ev.kind === "stream_reset") {
        args.emit({
          kind: "fork_stream_reset",
          forkId: args.forkId,
          discardedChars: text.length,
          ...args.parentRef,
        });
        text = "";
        thinking = "";
        thinkingSignature = "";
        toolCalls.length = 0;
        streamedToolNames.clear();
        stopReason = "stop";
        refusalExplanation = undefined;
      } else if (ev.kind === "quota_exhausted") {
        return await finishQuotaExhausted(args, ev);
      } else if (ev.kind === "error") {
        return {
          kind: "finished",
          consecutiveStalls: args.consecutiveStalls,
          result: await args.finish(
            {
              kind: "fork_complete",
              forkId: args.forkId,
              output: `fork error: ${ev.error}`,
              isError: true,
              ...args.parentRef,
            },
            { output: `fork error: ${ev.error}`, isError: true },
          ),
        };
      }
    }
    return {
      kind: "ready",
      consecutiveStalls: 0,
      text,
      thinking,
      thinkingSignature,
      toolCalls,
      stopReason,
      refusalExplanation,
      usage,
    };
  } catch (err) {
    return handleStreamError(args, err);
  }
}

function updateUsage(usage: UsageSnapshot, ev: Extract<ProviderEvent, { kind: "usage" }>): void {
  if (ev.inputTokens !== undefined) usage.inputTokens = ev.inputTokens;
  if (ev.outputTokens !== undefined) usage.outputTokens = ev.outputTokens;
  if (ev.thoughtTokens !== undefined) usage.thoughtTokens = ev.thoughtTokens;
  if (ev.cacheCreationInputTokens !== undefined)
    usage.cacheCreationInputTokens = ev.cacheCreationInputTokens;
  if (ev.cacheReadInputTokens !== undefined) usage.cacheReadInputTokens = ev.cacheReadInputTokens;
}

function emitUsageSnapshot(
  args: {
    forkId: string;
    ctx: RequestContext;
    emit: (event: Parameters<ForkEventSink>[0]) => void;
    parentRef: { parentToolCallId?: string };
  },
  usage: UsageSnapshot,
): void {
  args.emit({
    kind: "fork_usage",
    forkId: args.forkId,
    provider: args.ctx.provider,
    model: args.ctx.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    thoughtTokens: usage.thoughtTokens ?? 0,
    cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
    cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
    isSnapshot: true,
    ...args.parentRef,
  });
}

async function finishQuotaExhausted(
  args: Parameters<typeof consumeForkStream>[0],
  ev: Extract<ProviderEvent, { kind: "quota_exhausted" }>,
): Promise<ForkStreamOutcome> {
  args.emit({
    kind: "fork_quota_exhausted",
    forkId: args.forkId,
    provider: ev.provider,
    model: ev.model,
    resetEpochMs: ev.resetEpochMs,
    message: ev.message,
    ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
    ...args.parentRef,
  });
  const output = ev.message;
  const quotaExhausted = {
    provider: ev.provider,
    model: ev.model,
    resetEpochMs: ev.resetEpochMs,
    message: ev.message,
  };
  return {
    kind: "finished",
    consecutiveStalls: args.consecutiveStalls,
    result: await args.finish(
      { kind: "fork_complete", forkId: args.forkId, output, isError: true, ...args.parentRef },
      { output, isError: true, quotaExhausted },
    ),
  };
}

async function handleStreamError(
  args: Parameters<typeof consumeForkStream>[0],
  err: unknown,
): Promise<ForkStreamOutcome> {
  if (args.ctx.abortSignal?.aborted) {
    throw new AbortError();
  }
  if (args.isStalled()) {
    return handleStall(args);
  }
  const msg = err instanceof Error ? err.message : String(err);
  const output = `fork error: ${msg}`;
  args.appendSidechainRecord({
    type: "assistant_message",
    ts: nowIso(),
    content: output,
    provider: args.ctx.provider,
    model: args.ctx.model,
  });
  return {
    kind: "finished",
    consecutiveStalls: args.consecutiveStalls,
    result: await args.finish(
      { kind: "fork_complete", forkId: args.forkId, output, isError: true, ...args.parentRef },
      { output, isError: true },
    ),
  };
}

async function handleStall(
  args: Parameters<typeof consumeForkStream>[0],
): Promise<ForkStreamOutcome> {
  const lastStallArmAt = args.getLastStallArmAt();
  const lastStallLabel = args.getLastStallLabel();
  const sinceLastActivity = Date.now() - lastStallArmAt;
  const consecutiveStalls = args.consecutiveStalls + 1;
  const maxStallRetries = args.maxStallRetries ?? MAX_FORK_STALL_RETRIES;
  if (consecutiveStalls <= maxStallRetries) {
    args.appendSidechainRecord({
      type: "assistant_message",
      ts: nowIso(),
      content: `stream stalled — no events for ${args.stallMs}ms after "${lastStallLabel}"; re-sending the request (attempt ${consecutiveStalls}/${maxStallRetries}, turn ${args.turn})`,
      provider: args.ctx.provider,
      model: args.ctx.model,
    });
    args.resetStall();
    return { kind: "retry", consecutiveStalls };
  }
  const output = `stalled — no progress for ${args.stallMs}ms`;
  args.appendSidechainRecord({
    type: "assistant_message",
    ts: nowIso(),
    content: `${output} (turn ${args.turn}; last activity "${lastStallLabel}" ${sinceLastActivity}ms ago; ${maxStallRetries} retries exhausted)`,
    provider: args.ctx.provider,
    model: args.ctx.model,
  });
  return {
    kind: "finished",
    consecutiveStalls,
    result: await args.finish(
      { kind: "fork_complete", forkId: args.forkId, output, isError: true, ...args.parentRef },
      { output, isError: true, stalled: true, durationMs: Date.now() - args.runStart },
    ),
  };
}
