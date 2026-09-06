import {
  compileOutputSchema,
  STRUCTURED_OUTPUT_FORCING_INSTRUCTION,
  STRUCTURED_OUTPUT_NUDGE_MESSAGE,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from "@/engine/background/subagents/structured-output.ts";
import {
  listRunning as listRunningBackgroundTasks,
  setTaskParked,
} from "@/engine/background/tasks/background.ts";
import { wrapNotificationForModel } from "@/engine/background/tasks/notification.ts";
import { listWorkflowTasks } from "@/engine/background/workflows/runtime/store/store.ts";
import { accountFingerprint } from "@/engine/providers/_shared/account-identity.ts";
import * as providers from "@/engine/providers/registry.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import { RAPID_REFILL_FAILURE_TEXT } from "@/engine/session/compact/index.ts";
import type { UsageSnapshot } from "@/engine/session/compact/token-count.ts";
import { releaseForkChain } from "@/engine/session/infra.ts";
import { appendAgentRecordRaw } from "@/engine/session/persist.ts";
import { nowIso } from "@/engine/session/record/index.ts";
import {
  appendTaskReminderMessage,
  buildTaskReminderInjection,
} from "@/engine/session/task-reminder.ts";
import { killShellsForOwner } from "@/engine/tools/builtins/bash.ts";
import { clearDeferredAnnouncementsForScope } from "@/engine/tools/deferred.ts";
import type { ProviderToolDeclaration } from "@/engine/translator/index.ts";
import { sanitizeMessages } from "@/engine/translator/index.ts";
import { streamWithRetry } from "@/engine/transport/_infra/classify/retry.ts";
import { mcpCallIdentity } from "@/kernel/mcp/index.ts";
import { throwIfAborted } from "@/kernel/std/stream/abort.ts";
import type { ForkEventSink } from "@/kernel/std/types/events.ts";
import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";
import { lastAssistantRequestId } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { isForkOverBlockingLimit, maybeCompactFork, maybeMicroCompactFork } from "./compact.ts";
import { appendForkDeferredToolsReminder, composeForkSystem } from "./compose.ts";
import {
  DEGENERATE_TOOL_LOOP_MESSAGE,
  FORK_PROMPT_TOO_LONG_MESSAGE,
  FORK_RAPID_REFILL_TURN_SPAN,
  MAX_DEGENERATE_TOOL_CALLS,
  MAX_FORK_COMPACT_FAILURES,
  MAX_FORK_RAPID_REFILLS,
  STRUCTURED_OUTPUT_RETRIES_EXCEEDED,
} from "./constants.ts";
import { buildSubagentBaseDeclarations, withStructuredOutputDeclaration } from "./declarations.ts";
import { fireSubagentStartHooks, fireSubagentStopHooks, registerAgentHooks } from "./hooks.ts";
import { buildForkMessages } from "./messages.ts";
import { injectQueuedUserInput } from "./queued-input.ts";
import { withGuaranteedReport } from "./report.ts";
import { isTooShortForReturn } from "./return-quality.ts";
import { withSidechainMetadata } from "./sidechain.ts";
import { waitForAgentSteer } from "./steering.ts";
import { consumeForkStream } from "./stream-consumer.ts";
import { maxStructuredOutputRetries } from "./structured-retries.ts";
import {
  applyForkToolResultBudget,
  dispatchForkToolCalls,
  type ForkToolDispatchState,
} from "./tool-dispatch.ts";
import type { ForkSpec, SidechainRecord, SubagentResult } from "./types.ts";

// A fork must not settle while it still owns running background work: a
// background agent/shell or a launched workflow keyed to this fork id keeps the
// owner alive so its completion routes back here instead of stranding. This is
// the keepalive contract — exported for direct regression coverage.
export function hasRunningOwnedWork(ownerId: string): boolean {
  if (listRunningBackgroundTasks().some((task) => task.ownerId === ownerId)) return true;
  return listWorkflowTasks().some((task) => task.ownerId === ownerId && task.status === "running");
}

function hasPendingOwnedNotification(ownerId: string): boolean {
  return emitQueue
    .peek({ ownerId })
    .some((item) => item.target === "inventory" && item.payload.kind === "task_notification_xml");
}

export async function runForkLoopInContext(
  spec: ForkSpec,
  forkId: string,
  ctx: RequestContext,
): Promise<SubagentResult> {
  const { name, body, allowSet, prompt, description, sink } = spec;
  const provider = providers.get(ctx.provider);
  const emit = (event: Parameters<ForkEventSink>[0]): void => sink?.(event);
  const parentRef = spec.parentToolCallId ? { parentToolCallId: spec.parentToolCallId } : {};

  const effortRef = ctx.effort !== null ? { effort: ctx.effort } : {};
  const startEvent: Parameters<ForkEventSink>[0] = description
    ? {
        kind: "fork_start",
        forkId,
        name,
        provider: ctx.provider,
        model: ctx.model,
        ...effortRef,
        description,
        ...parentRef,
      }
    : {
        kind: "fork_start",
        forkId,
        name,
        provider: ctx.provider,
        model: ctx.model,
        ...effortRef,
        ...parentRef,
      };
  emit(startEvent);

  let sidechainWriteTail: Promise<void> = Promise.resolve();
  const appendSidechainRecord = (record: SidechainRecord): void => {
    const nextRecord = withSidechainMetadata(record, spec);
    sidechainWriteTail = sidechainWriteTail
      .then(() =>
        appendAgentRecordRaw(
          {
            cwd: ctx.originalCwd ?? ctx.cwd,
            sessionId: ctx.sessionId,
            agentId: forkId,
          },
          nextRecord,
        ),
      )
      .catch((err) => {
        const error = err instanceof Error ? err.message : String(err);
        const event: Parameters<ForkEventSink>[0] = {
          kind: "sidechain_persist_error",
          agentId: spec.agentId ?? forkId,
          error,
          ...(spec.parentToolCallId ? { parentToolCallId: spec.parentToolCallId } : {}),
        };
        emit(event);
      });
  };
  const finish = async (event: Parameters<ForkEventSink>[0], result: SubagentResult) => {
    emit(event);
    await sidechainWriteTail;
    return result;
  };

  appendSidechainRecord({
    type: "user_message",
    ts: nowIso(),
    content: prompt,
    provider: ctx.provider,
    model: ctx.model,
    ...(spec.promptInlineImages !== undefined && spec.promptInlineImages.length > 0
      ? { inlineImages: spec.promptInlineImages }
      : {}),
  });

  let compiledSchema: ReturnType<typeof compileOutputSchema> | null = null;
  if (!spec.inheritParentTurn && spec.outputSchema !== undefined) {
    const compiled = compileOutputSchema(spec.outputSchema);
    if (compiled.kind === "invalid") {
      return await finish(
        {
          kind: "fork_complete",
          forkId,
          output: `agent({schema}) received an invalid JSON Schema: ${compiled.error}`,
          isError: true,
          ...parentRef,
        },
        {
          output: `agent({schema}) received an invalid JSON Schema: ${compiled.error}`,
          isError: true,
        },
      );
    }
    compiledSchema = compiled;
  }

  const { parentTurn, declarations: baseDeclarations } = buildSubagentBaseDeclarations(spec, ctx);
  const declarations: ProviderToolDeclaration[] =
    compiledSchema !== null && spec.outputSchema !== undefined
      ? withStructuredOutputDeclaration(baseDeclarations, spec.outputSchema)
      : baseDeclarations;

  const fork: Message[] =
    spec.initialMessages ?? buildForkMessages(ctx, name, body, prompt, spec.skillMessages);
  if (!parentTurn && fork[0]?.role !== "system") {
    fork.unshift({
      role: "system",
      content: composeForkSystem({ ctx, name, body, firstPrompt: prompt }),
    });
  }
  // A resumed fork already carries its announcement in the restored transcript.
  if (spec.initialMessages === undefined) {
    appendForkDeferredToolsReminder(fork, ctx, spec, declarations);
  }
  if (compiledSchema !== null) {
    fork.push({
      role: "user",
      content: [{ type: "text", text: STRUCTURED_OUTPUT_FORCING_INSTRUCTION }],
    });
  }

  const hookHandlers = registerAgentHooks(forkId, ctx.sessionId, spec.agentHooks, name);
  await fireSubagentStartHooks(forkId, ctx.sessionId, spec.agentId ?? name);

  let lastText = "";
  let compactFailures = 0;
  let lastCompactTurn: number | null = null;
  let lastForkUsage: UsageSnapshot | null = null;
  let rapidRefills = 0;
  let expandReprompts = 0;
  let ownedCompletionGraceUsed = false;
  let lastTurnStopReason = "stop";
  let lastTurnOutputTokens = 0;
  const maxStructuredRetries = maxStructuredOutputRetries();
  let dispatchState: ForkToolDispatchState = {
    degenerateToolCalls: 0,
    lastFailingSignature: null,
    structuredOutputRetries: 0,
    lastStructuredError: null,
    structuredValue: undefined,
    structuredOutputConsumed: false,
  };

  const failStructuredOutputRetries = (): Promise<SubagentResult> => {
    const detail =
      dispatchState.lastStructuredError !== null
        ? ` — last schema error: ${dispatchState.lastStructuredError}`
        : "";
    const output = `Reached maximum StructuredOutput retries (${maxStructuredRetries})${detail}`;
    appendSidechainRecord({
      type: "assistant_message",
      ts: nowIso(),
      content: output,
      provider: ctx.provider,
      model: ctx.model,
    });
    return finish(
      { kind: "fork_complete", forkId, output, isError: true, ...parentRef },
      { output, isError: true, stopReason: STRUCTURED_OUTPUT_RETRIES_EXCEEDED },
    );
  };

  const runStart = Date.now();

  try {
    for (let turn = 0; ; turn++) {
      for (const declaration of buildSubagentBaseDeclarations(spec, ctx).declarations) {
        if (!declarations.some((existing) => existing.name === declaration.name)) {
          const structuredIndex = declarations.findIndex(
            (existing) => existing.name === STRUCTURED_OUTPUT_TOOL_NAME,
          );
          declarations.splice(
            structuredIndex < 0 ? declarations.length : structuredIndex,
            0,
            declaration,
          );
        }
      }
      throwIfAborted(ctx.abortSignal);
      if (spec.maxTurns !== undefined && turn >= spec.maxTurns) {
        // A fork keeps itself alive while it owns running background work so the
        // completion routes back here (the keepalive park below). Hitting
        // maxTurns at that exact boundary must not strand a completion the fork
        // explicitly waited for — otherwise it reroutes to main with no context
        // and the fork's answer omits it. Grant one final turn to drain and
        // answer over the pending completion, then stop. Single-shot so a
        // spawn-wait loop cannot outrun the cap.
        if (ownedCompletionGraceUsed || !hasPendingOwnedNotification(forkId)) break;
        ownedCompletionGraceUsed = true;
      }

      const ownedNotifications = emitQueue
        .takeForOwner(forkId)
        .map((item) => (item.payload.kind === "task_notification_xml" ? item.payload.text : null))
        .filter((text): text is string => text !== null);
      if (ownedNotifications.length > 0) {
        fork.push({
          role: "user",
          content: ownedNotifications.map((text) => ({
            type: "text",
            text: wrapNotificationForModel(text),
          })),
        });
        for (const text of ownedNotifications) {
          appendSidechainRecord({
            type: "user_message",
            ts: nowIso(),
            content: wrapNotificationForModel(text),
            provider: ctx.provider,
            model: ctx.model,
          });
        }
      }

      injectQueuedUserInput({ spec, fork, ctx, appendSidechainRecord });

      if (turn > 0) {
        maybeMicroCompactFork(fork, ctx, lastForkUsage, appendSidechainRecord);
      }
      if (turn > 0 && rapidRefills >= MAX_FORK_RAPID_REFILLS) {
        appendSidechainRecord({
          type: "assistant_message",
          ts: nowIso(),
          content: RAPID_REFILL_FAILURE_TEXT,
          provider: ctx.provider,
          model: ctx.model,
        });
        return await finish(
          {
            kind: "fork_complete",
            forkId,
            output: RAPID_REFILL_FAILURE_TEXT,
            isError: true,
            ...parentRef,
          },
          { output: RAPID_REFILL_FAILURE_TEXT, isError: true },
        );
      }
      if (compactFailures >= MAX_FORK_COMPACT_FAILURES) {
        // Re-arm once enough turns have passed since the last compact attempt
        // without a rapid refill — mirrors the main session breaker
        // (queue/runtime/compact/auto.ts): left permanently open, 3 transient
        // failures (e.g. a network blip) would disable compaction for the
        // rest of the fork run, so the transcript grows unbounded until it
        // 400s. A genuine repeat failure just re-trips it.
        const turnsSinceLastCompact = lastCompactTurn === null ? turn : turn - lastCompactTurn;
        if (turnsSinceLastCompact >= FORK_RAPID_REFILL_TURN_SPAN) {
          compactFailures = 0;
        }
      }

      // The blocking-limit guard runs on every turn, including turn 0: a fork
      // that inherits a near-full parent transcript (dispatchFork) can be over
      // the ceiling before it ever sends a request, so the regular turn > 0
      // gate below must not be the only path into a compaction attempt.
      const overBlockingLimitBeforeCompact = isForkOverBlockingLimit(fork, ctx, lastForkUsage);
      if (
        (turn > 0 || overBlockingLimitBeforeCompact) &&
        compactFailures < MAX_FORK_COMPACT_FAILURES
      ) {
        const outcome = await maybeCompactFork(fork, ctx, lastForkUsage, declarations);
        if (outcome === "compacted") {
          if (lastCompactTurn !== null && turn - lastCompactTurn < FORK_RAPID_REFILL_TURN_SPAN) {
            rapidRefills += 1;
          } else {
            rapidRefills = 0;
          }
          lastCompactTurn = turn;
          // The stale usage snapshot no longer describes the (now much
          // smaller) fork transcript, and no message carries its own `usage`
          // field, so leaving it set would make the very next token estimate
          // report the pre-compaction size. Clearing it forces a fresh
          // rough estimate from the compacted messages themselves.
          lastForkUsage = null;
        } else if (outcome === "failed") {
          compactFailures += 1;
        }
      }
      if (
        overBlockingLimitBeforeCompact &&
        (compactFailures >= MAX_FORK_COMPACT_FAILURES ||
          isForkOverBlockingLimit(fork, ctx, lastForkUsage))
      ) {
        appendSidechainRecord({
          type: "assistant_message",
          ts: nowIso(),
          content: FORK_PROMPT_TOO_LONG_MESSAGE,
          provider: ctx.provider,
          model: ctx.model,
        });
        return await finish(
          {
            kind: "fork_complete",
            forkId,
            output: FORK_PROMPT_TOO_LONG_MESSAGE,
            isError: true,
            ...parentRef,
          },
          { output: FORK_PROMPT_TOO_LONG_MESSAGE, isError: true },
        );
      }
      throwIfAborted(ctx.abortSignal);
      const budgetFork = await applyForkToolResultBudget(fork, ctx, appendSidechainRecord);
      fork.splice(0, fork.length, ...budgetFork);
      // Planning tasks live in the session-shared list (the same one the
      // Task tools read/write); the reminder must list that scope, never a
      // per-agent directory that no tool ever writes.
      const taskReminder = buildTaskReminderInjection({
        messages: fork,
        effectiveTools: declarations,
      });
      if (taskReminder !== null) appendTaskReminderMessage(fork, taskReminder);
      if (!parentTurn && fork[0]?.role === "system") {
        const prevRequestId = lastAssistantRequestId(fork);
        fork[0] = {
          role: "system",
          content: composeForkSystem({
            ctx,
            name,
            body,
            firstPrompt: prompt,
            ...(prevRequestId ? { previousRequestId: prevRequestId } : {}),
          }),
        };
      }
      const requestMessages = parentTurn
        ? provider.composeMessages(
            parentTurn.harness,
            // The inherited parent transcript can reference tools this fork
            // never declares (e.g. fork-disallowed ones the parent loaded via
            // ToolSearch); scope preservation to the fork's own declarations
            // or the provider rejects the request at pre-flight.
            sanitizeMessages(fork, {
              preserveToolReferences: provider.id === "anthropic",
              declaredToolNames: new Set(declarations.map((declaration) => declaration.name)),
            }),
          )
        : provider.applyTrailingCacheControl
          ? provider.applyTrailingCacheControl(fork)
          : fork;
      const streamCtx: RequestContext = { ...ctx };
      // A builder, not a pre-built body: each retry re-translates the request,
      // so a per-session recovery flagged by recoverableError (e.g. dropping a
      // rejected reasoning replay) reaches the retried attempt.
      const stream = streamWithRetry(streamCtx, provider, () =>
        provider.translateRequest(streamCtx, requestMessages, declarations),
      );

      const streamOutcome = await consumeForkStream({
        stream,
        streamSignal: ctx.abortSignal,
        ctx,
        forkId,
        parentRef,
        emit,
        streamToolInputFor: spec.streamToolInputFor,
        finish,
        appendSidechainRecord,
      });
      if (streamOutcome.kind === "finished") return streamOutcome.result;

      const {
        text,
        thinking,
        thinkingSignature,
        toolCalls,
        stopReason,
        refusalExplanation,
        usage,
      } = streamOutcome;
      lastTurnStopReason = stopReason;
      lastTurnOutputTokens = usage.outputTokens;

      if (usage.inputTokens || usage.outputTokens) {
        emit({
          kind: "fork_usage",
          forkId,
          provider: ctx.provider,
          model: ctx.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          thoughtTokens: usage.thoughtTokens ?? 0,
          cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
          cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
          ...parentRef,
        });
        appendSidechainRecord({
          type: "usage",
          ts: nowIso(),
          provider: ctx.provider,
          model: ctx.model,
          session_id: ctx.sessionId,
          request_count: 1,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          thought_tokens: usage.thoughtTokens ?? 0,
          cache_creation_input_tokens: usage.cacheCreationInputTokens ?? 0,
          cache_read_input_tokens: usage.cacheReadInputTokens ?? 0,
        });
        lastForkUsage = usage;
      }

      if (text.length > 0) lastText = text;

      const blocks: ContentBlock[] = [];
      if (thinking.length > 0 || thinkingSignature.length > 0) {
        const forkAccount = accountFingerprint(ctx.provider);
        const block: Extract<ContentBlock, { type: "thinking" }> = {
          type: "thinking",
          text: thinking,
          producedBy: ctx.provider,
          producedModel: ctx.model,
        };
        if (thinkingSignature) block.signature = thinkingSignature;
        if (forkAccount) block.producedAccount = forkAccount;
        blocks.push(block);
      }
      if (text.length > 0) blocks.push({ type: "text", text });
      if (text.length > 0 || thinking.length > 0) {
        appendSidechainRecord({
          type: "assistant_message",
          ts: nowIso(),
          content: text,
          provider: ctx.provider,
          model: ctx.model,
          ...(thinking.length > 0 ? { thinking } : {}),
        });
      }
      for (const c of toolCalls) {
        blocks.push({
          type: "tool_use",
          id: c.id,
          name: c.name,
          input: c.input,
        });
        const mcpIdentity = mcpCallIdentity(c.name);
        appendSidechainRecord({
          type: "tool_call",
          ts: nowIso(),
          tool_name: c.name,
          args: c.input,
          call_id: c.id,
          ...(mcpIdentity ? { mcpIdentity } : {}),
          provider: ctx.provider,
          model: ctx.model,
        });
      }
      if (blocks.length > 0) {
        const account = accountFingerprint(ctx.provider);
        fork.push({
          role: "assistant",
          content: blocks,
          producedBy: ctx.provider,
          producedModel: ctx.model,
          ...(account ? { producedAccount: account } : {}),
          ...(streamCtx.responseRequestId ? { requestId: streamCtx.responseRequestId } : {}),
        });
      }

      if (stopReason === "refusal") {
        const refusalOut =
          refusalExplanation && refusalExplanation.trim().length > 0
            ? refusalExplanation
            : "The model declined to respond to this request.";
        appendSidechainRecord({
          type: "assistant_message",
          ts: nowIso(),
          content: refusalOut,
          provider: ctx.provider,
          model: ctx.model,
        });
        return await finish(
          {
            kind: "fork_complete",
            forkId,
            output: refusalOut,
            isError: true,
            ...parentRef,
          },
          { output: refusalOut, isError: true },
        );
      }

      if (stopReason !== "tool_calls" || toolCalls.length === 0) {
        if (compiledSchema !== null && !dispatchState.structuredOutputConsumed) {
          if (dispatchState.structuredOutputRetries >= maxStructuredRetries) {
            return await failStructuredOutputRetries();
          }
          dispatchState.structuredOutputRetries += 1;
          fork.push({
            role: "user",
            content: [{ type: "text", text: STRUCTURED_OUTPUT_NUDGE_MESSAGE }],
          });
          appendSidechainRecord({
            type: "user_message",
            ts: nowIso(),
            content: STRUCTURED_OUTPUT_NUDGE_MESSAGE,
            provider: ctx.provider,
            model: ctx.model,
          });
          continue;
        }
        if (expandReprompts < 1 && isTooShortForReturn(text)) {
          expandReprompts += 1;
          const reprompt =
            'Your previous message was too short to be useful to the calling agent. The caller ONLY sees your final assistant message — not your tool calls, intermediate reads, or working notes. Expand your response now into a complete, self-contained summary covering everything the caller asked for: findings, results, paths to any files you wrote, severity tallies if applicable. Do not respond with single words like "done". Write the full deliverable.';
          fork.push({
            role: "user",
            content: [{ type: "text", text: reprompt }],
          });
          appendSidechainRecord({
            type: "user_message",
            ts: nowIso(),
            content: reprompt,
            provider: ctx.provider,
            model: ctx.model,
          });
          continue;
        }
        if (injectQueuedUserInput({ spec, fork, ctx, appendSidechainRecord })) continue;
        if (hasPendingOwnedNotification(forkId)) continue;
        if (hasRunningOwnedWork(forkId)) {
          // Parked on owned work, two inputs can wake this loop: a child's
          // notification landing in the owner inventory, or a steer queued for
          // this fork (agent-view submit / an addressed message). Whichever
          // fires first wins; the shared wake signal releases the loser's
          // subscription, and the next iteration's drains consume the input —
          // waking is not claiming, so a race cannot double-deliver.
          const wake = new AbortController();
          const wakeSignal =
            ctx.abortSignal !== undefined
              ? AbortSignal.any([ctx.abortSignal, wake.signal])
              : wake.signal;
          setTaskParked(forkId, true);
          try {
            await Promise.race([
              emitQueue.waitForOwner(forkId, wakeSignal),
              waitForAgentSteer(forkId, wakeSignal),
            ]);
          } finally {
            wake.abort();
            setTaskParked(forkId, false);
          }
          continue;
        }
        break;
      }

      const dispatchOutcome = await dispatchForkToolCalls({
        toolCalls,
        ctx,
        spec,
        forkId,
        name,
        allowSet,
        parentRef,
        compiledSchema,
        hookHandlers,
        state: dispatchState,
        emit,
        finish,
        appendSidechainRecord,
      });
      if (dispatchOutcome.kind === "finished") return dispatchOutcome.result;
      dispatchState = dispatchOutcome.state;
      fork.push({ role: "user", content: dispatchOutcome.results });
      // Foreground nested-task terminal publication is deliberately after the
      // Agent tool_result enters the parent sidechain. Detached completions do
      // not wait here; they route through the owner's FIFO inventory instead.
      dispatchOutcome.commitTaskCompletions();

      if (dispatchState.structuredOutputConsumed) break;
      if (
        compiledSchema !== null &&
        !dispatchState.structuredOutputConsumed &&
        dispatchState.structuredOutputRetries >= maxStructuredRetries
      ) {
        return await failStructuredOutputRetries();
      }
      if (dispatchState.degenerateToolCalls >= MAX_DEGENERATE_TOOL_CALLS) {
        appendSidechainRecord({
          type: "assistant_message",
          ts: nowIso(),
          content: DEGENERATE_TOOL_LOOP_MESSAGE,
          provider: ctx.provider,
          model: ctx.model,
        });
        return await finish(
          {
            kind: "fork_complete",
            forkId,
            output: DEGENERATE_TOOL_LOOP_MESSAGE,
            isError: true,
            ...parentRef,
          },
          { output: DEGENERATE_TOOL_LOOP_MESSAGE, isError: true },
        );
      }
    }

    const output = lastText.length > 0 ? lastText : "(Subagent completed but returned no output.)";
    const finalOutput = withGuaranteedReport(body, output);
    const baseResult: SubagentResult = {
      output: finalOutput,
      isError: false,
      stopReason: lastTurnStopReason,
      outputTokens: lastTurnOutputTokens,
      durationMs: Date.now() - runStart,
    };
    const finalResult: SubagentResult =
      dispatchState.structuredValue !== undefined
        ? { ...baseResult, structured: dispatchState.structuredValue }
        : baseResult;
    return await finish(
      {
        kind: "fork_complete",
        forkId,
        output: finalOutput,
        isError: false,
        ...parentRef,
      },
      finalResult,
    );
  } finally {
    killShellsForOwner(forkId);
    clearDeferredAnnouncementsForScope(forkId);
    await fireSubagentStopHooks(forkId, ctx.sessionId);
    releaseForkChain(ctx.sessionId, forkId, ctx.originalCwd ?? ctx.cwd);
  }
}
