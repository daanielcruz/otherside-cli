import { recordCodexRawReplayDiagnostic } from "@/devtools/codex-raw-stream.ts";
import { recordTurnCacheUsage } from "@/engine/providers/_shared/cache.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import {
  checkContextOverflow,
  forceCompactOnOverflow,
  maybeCompact,
  maybeMicroCompact,
} from "@/engine/queue/runtime/compact/orchestration.ts";
import { evaluateGoal, goalContinuePrompt } from "@/engine/queue/runtime/goal-evaluation.ts";
import { flushOrphanToolUses } from "@/engine/queue/runtime/orphan-synth.ts";
import {
  collectRecallReminders,
  type MemoryRecallPrefetch,
} from "@/engine/queue/runtime/prefetch.ts";
import { makeRequestContext } from "@/engine/queue/runtime/request-context.ts";
import { stopHookBlockCap } from "@/engine/queue/runtime/stop-hook-classifier.ts";
import { setStopHookActiveTurn } from "@/engine/queue/runtime/stop-hook-rewake.ts";
import { queuedInputBlocks } from "@/engine/queue/runtime/turn-prompts.ts";
import { getActiveGoal } from "@/engine/queue/state.ts";
import { fireConfiguredHooks } from "@/kernel/hooks/handler.ts";
import { uuidv4 } from "@/kernel/std/id.ts";
import type { AgentEvent } from "@/kernel/std/types/events.ts";
import { type ContentBlock } from "@/kernel/std/types/message.ts";
import { commitAssistantMessage } from "./assistant-commit.ts";
import { TurnAttempt } from "./attempt.ts";
import { beginTurnEpoch, isSuperseded } from "./epoch.ts";
import { loopErrorMeta } from "./loop-error-meta.ts";
import { compactDepsFor, runningSessionWorkCount } from "./loop-support.ts";
import { EXITED_PLAN_MODE_REMINDER, planModeReminder } from "./plan-reminders.ts";
import {
  fireStopPromptHooks,
  mergeUsageSnap,
  openProviderStream,
  turnStreamDeps,
} from "./stream.ts";
import { appendNotificationRecords, dispatchTurnToolCalls } from "./tool-dispatch.ts";
import { openTurnPrompt } from "./turn-opening.ts";
import type { TurnLoopHost } from "./types.ts";

export type { TurnLoopHost } from "./types.ts";

const PER_TURN_CHAR_CAP = 200_000;

export async function* runTurn(
  host: TurnLoopHost,
  userInput: string | ContentBlock[],
  keywordText?: string,
): AsyncIterable<AgentEvent> {
  const turnEpoch = beginTurnEpoch(host);
  const isCancelled = (): boolean => host.cancelled || isSuperseded(host, turnEpoch);
  host.cancelled = false;
  host.currentTurnId = uuidv4();
  const controller = new AbortController();
  host.activeAbortController = controller;
  const initialQueuedMessages =
    typeof userInput === "string" && userInput.length === 0
      ? (host.pendingUserInputDrainer?.() ?? [])
      : [];
  if (initialQueuedMessages.length > 0) {
    host.deps.session.messages.push({
      role: "user",
      content: queuedInputBlocks(initialQueuedMessages),
    });
  }
  const turnStartDrain = emitQueue.setTurnActive(true);
  const turnStartPushedMessages = turnStartDrain !== null && turnStartDrain.llmBlocks.length > 0;
  if (turnStartPushedMessages && turnStartDrain !== null) {
    host.deps.session.messages.push({ role: "user", content: turnStartDrain.llmBlocks });
    appendNotificationRecords(host, turnStartDrain.notificationTexts);
  }
  // A turn started by a stop-hook rewake runs its own Stop hooks with
  // STOP_HOOK_ACTIVE so a hook script can break the rewake loop.
  setStopHookActiveTurn(turnStartDrain?.stopHookActive === true);
  let memoryRecall: MemoryRecallPrefetch | undefined;

  try {
    const opening = yield* openTurnPrompt({
      host,
      userInput,
      keywordText,
      initialQueuedMessages,
      turnStartPushedMessages,
      abortSignal: controller.signal,
    });
    memoryRecall = opening.memoryRecall;
    if (!opening.proceed) return;
    const turnState = opening.turnState;

    if (Number.isFinite(host.compactState.turnsSinceLast)) {
      host.compactState.turnsSinceLast += 1;
    }
    yield* maybeMicroCompact(compactDepsFor(host));
    yield* maybeCompact(compactDepsFor(host));

    let turn = 0;
    let goalContinueCount = 0;
    let stopHookBlockCount = 0;
    let lastSeenPermissionMode = turnState.permissionMode;
    let consecutiveSilentTurns = 0;
    let maxOutputTokensRecoveryCount = 0;
    let hasRetriedMalformedToolUse = false;
    while (true) {
      if (isCancelled()) return;
      if (turn > 0) {
        yield* maybeMicroCompact(compactDepsFor(host));
        yield* maybeCompact(compactDepsFor(host));
        // Permission mode can flip mid-turn (shift+tab, a remote client).
        // Re-evaluated at the top of every continuation so the imminent
        // request carries the change. Ultracode reminders deliberately do NOT
        // re-evaluate here — they belong to the initial prompt pass only, so
        // a /ultracode flip mid-turn surfaces on the next typed prompt.
        const liveState = host.deps.broker.read();
        const midTurnReminders: string[] = [];
        if (liveState.permissionMode === "plan" && lastSeenPermissionMode !== "plan") {
          midTurnReminders.push(planModeReminder(host.deps.session.id));
        }
        if (liveState.permissionMode !== "plan" && lastSeenPermissionMode === "plan") {
          midTurnReminders.push(EXITED_PLAN_MODE_REMINDER);
        }
        lastSeenPermissionMode = liveState.permissionMode;
        // Injections pushed WHILE the turn runs (e.g. /goal set) drain at the
        // next continuation boundary so they enter the running turn as urgent,
        // instead of waiting for the next turn start. Same queue, same shape as
        // turn-start injections — a goal meta-message is raw instruction text.
        const midTurnInjections = host.injections.drain();
        const midTurnBlocks: ContentBlock[] = [
          ...midTurnReminders.map((text) => ({
            type: "text" as const,
            text: `<system-reminder>\n${text}\n</system-reminder>`,
          })),
          ...(midTurnInjections.length > 0
            ? [{ type: "text" as const, text: midTurnInjections.join("\n\n") }]
            : []),
        ];
        if (midTurnBlocks.length > 0) {
          host.deps.session.messages.push({ role: "user", content: midTurnBlocks });
        }
      }
      if (isCancelled()) return;
      const overflowGuard = checkContextOverflow(compactDepsFor(host));
      if (overflowGuard) {
        const emitOverflowError = function* (message: string): Generator<AgentEvent> {
          const overflowMeta = loopErrorMeta({
            message,
            provider: turnState.provider,
            model: turnState.model,
            attempt: turn,
          });
          yield { kind: "error", error: message, meta: overflowMeta };
        };
        if (overflowGuard.kind === "prefix") {
          yield* emitOverflowError(overflowGuard.message);
          return;
        }
        yield* forceCompactOnOverflow(compactDepsFor(host));
        if (isCancelled()) return;
        const stillOverflowing = checkContextOverflow(compactDepsFor(host));
        if (stillOverflowing) {
          yield* emitOverflowError(stillOverflowing.message);
          return;
        }
      }
      turn += 1;
      yield { kind: "turn_start", turn };

      const attempt = new TurnAttempt();
      let errorEmittedThisTurn = false;
      recordCodexRawReplayDiagnostic({
        event: "turn_stream_open",
        sessionId: host.deps.session.id,
        turn,
      });
      try {
        for await (const ev of openProviderStream(turnStreamDeps(host), controller.signal)) {
          if (isCancelled()) return;
          yield ev;
          if (ev.kind === "text_delta") {
            attempt.text += ev.text;
            if (!attempt.charCapTripped && attempt.text.length > PER_TURN_CHAR_CAP) {
              attempt.charCapTripped = true;
              // Abort this turn's own controller directly, not whatever host
              // .activeAbortController currently points at — a zombie (superseded)
              // turn crossing the cap must not abort a newer turn's or a compact's
              // controller (see the epoch comment above).
              controller.abort("char-cap");
              const charCapMsg = `runaway turn aborted: assistant text exceeded ${PER_TURN_CHAR_CAP} chars in a single turn`;
              const charCapMeta = loopErrorMeta({
                message: charCapMsg,
                provider: turnState.provider,
                model: turnState.model,
                attempt: turn,
              });
              yield { kind: "error", error: charCapMsg, meta: charCapMeta };
              break;
            }
          } else if (ev.kind === "thinking_delta") {
            attempt.thinking += ev.text;
          } else if (ev.kind === "thinking_signature") {
            attempt.thinkingSignature = ev.signature;
          } else if (ev.kind === "tool_call_complete") {
            if (!ev.serverHandled) {
              attempt.toolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
              recordCodexRawReplayDiagnostic({
                event: "turn_tool_call_complete",
                toolCallId: ev.id,
                toolName: ev.name,
                sessionId: host.deps.session.id,
              });
            }
          } else if (ev.kind === "message_stop") {
            attempt.stopReason = ev.stop_reason;
            if (ev.refusal !== undefined) attempt.refusalExplanation = ev.refusal;
            recordCodexRawReplayDiagnostic({
              event: "turn_message_stop",
              stopReason: attempt.stopReason,
              toolCalls: attempt.toolCallRefs(),
              sessionId: host.deps.session.id,
            });
          } else if (ev.kind === "usage") {
            attempt.usage = mergeUsageSnap(attempt.usage, ev);
          } else if (ev.kind === "error") {
            errorEmittedThisTurn = true;
            attempt.providerError = ev.error;
          } else if (ev.kind === "retry_status") {
            recordCodexRawReplayDiagnostic({
              event: "turn_retry_status",
              sessionId: host.deps.session.id,
              turn,
              attempt: ev.attempt,
              reason: ev.reason,
            });
          } else if (ev.kind === "quota_exhausted") {
            commitAssistantMessage(host.deps, attempt);
            host.cancel();
            return;
          } else if (ev.kind === "message_start") {
            if (ev.id !== undefined) attempt.messageId = ev.id;
            if (ev.requestId !== undefined) attempt.requestId = ev.requestId;
            if (ev.provider !== undefined) attempt.producedProvider = ev.provider;
            if (ev.model !== undefined) attempt.producedModel = ev.model;
          } else if (ev.kind === "stream_reset") {
            // Partial-content re-send: the provider re-streams this turn from
            // scratch, so discard everything this attempt collected — otherwise
            // the committed wire message doubles its text and carries orphaned
            // tool_use blocks (no matching tool_result) that poison later requests.
            attempt.restart();
          }
        }
      } catch (streamError) {
        const errorDetails =
          streamError instanceof Error ? streamError.message : String(streamError);
        recordCodexRawReplayDiagnostic({
          event: "turn_stream_error",
          sessionId: host.deps.session.id,
          turn,
          error: errorDetails,
          toolCalls: attempt.toolCallRefs(),
        });
        await fireConfiguredHooks(host.deps.config, "stopFailure", {
          kind: "stopFailure",
          ctx: {
            sessionId: host.deps.session.id,
            cwd: host.deps.session.cwd,
            error: "unknown",
            errorDetails,
            ...(attempt.text.trim() ? { lastAssistantMessage: attempt.text } : {}),
          },
        });
        throw streamError;
      }
      if (attempt.providerError !== undefined) {
        await fireConfiguredHooks(host.deps.config, "stopFailure", {
          kind: "stopFailure",
          ctx: {
            sessionId: host.deps.session.id,
            cwd: host.deps.session.cwd,
            error: "unknown",
            errorDetails: attempt.providerError,
            ...(attempt.text.trim() ? { lastAssistantMessage: attempt.text } : {}),
          },
        });
      }
      recordCodexRawReplayDiagnostic({
        event: "turn_stream_closed",
        sessionId: host.deps.session.id,
        turn,
        stopReason: attempt.stopReason,
        toolCalls: attempt.toolCallRefs(),
        textBytes: Buffer.byteLength(attempt.text, "utf8"),
        errorEmittedThisTurn,
      });

      // A refusal turn carries no usable content; never commit it so it cannot
      // re-send to the model on the next user message (live or after resume).
      if (attempt.stopReason !== "refusal") {
        commitAssistantMessage(host.deps, attempt);
      }

      if (attempt.usage) {
        const ctxState = host.deps.broker.read();
        recordTurnCacheUsage(
          ctxState.provider,
          attempt.usage.cacheCreationInputTokens,
          attempt.usage.cacheReadInputTokens,
        );
      }

      yield { kind: "turn_end", turn, stopReason: attempt.stopReason };

      if (attempt.charCapTripped) {
        flushOrphanToolUses(host.deps, attempt.toolCalls, "char-cap aborted turn");
        return;
      }

      // Refusal is deterministic — retrying re-refuses. Surface the model's
      // explanation via the retry modal and stop; never recover/retry silently.
      if (attempt.stopReason === "refusal") {
        const refusalMsg =
          attempt.refusalExplanation && attempt.refusalExplanation.trim().length > 0
            ? attempt.refusalExplanation
            : "The model declined to respond to this request.";
        const refusalMeta = loopErrorMeta({
          message: refusalMsg,
          provider: turnState.provider,
          model: turnState.model,
          attempt: turn,
        });
        yield { kind: "error", error: refusalMsg, meta: refusalMeta };
        return;
      }

      if (attempt.stopReason === "tool_calls" && attempt.toolCalls.length === 0) {
        if (!hasRetriedMalformedToolUse) {
          hasRetriedMalformedToolUse = true;
          const msgs = host.deps.session.messages;
          if (msgs[msgs.length - 1]?.role === "assistant") msgs.pop();
          host.deps.session.messages.push({
            role: "user",
            content: [
              {
                type: "text",
                text: "The previous response failed to produce a valid tool call. Please retry the tool call now.",
              },
            ],
          });
          yield { kind: "silent_turn_end_recovery", turn, iteration: 1 };
          continue;
        } else {
          const toolParseMsg = "The model's tool call could not be parsed (retry also failed).";
          const toolParseMeta = loopErrorMeta({
            message: toolParseMsg,
            provider: turnState.provider,
            model: turnState.model,
            attempt: turn,
          });
          yield { kind: "error", error: toolParseMsg, meta: toolParseMeta };
          return;
        }
      }

      if (attempt.stopReason === "length") {
        if (maxOutputTokensRecoveryCount < 3) {
          maxOutputTokensRecoveryCount += 1;
          host.deps.session.messages.push({
            role: "user",
            content: [
              {
                type: "text",
                text: "Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.",
              },
            ],
          });
          yield {
            kind: "silent_turn_end_recovery",
            turn,
            iteration: maxOutputTokensRecoveryCount,
          };
          continue;
        }
      }

      if (attempt.stopReason !== "tool_calls" || attempt.toolCalls.length === 0) {
        if (!attempt.producedNothing()) consecutiveSilentTurns = 0;
        const preEvalGoal = getActiveGoal(host.deps.session.id);
        const runningBg = preEvalGoal ? runningSessionWorkCount(host.deps.session.id) : 0;
        if (preEvalGoal && runningBg > 0) {
          yield {
            kind: "goal_paused_bg",
            condition: preEvalGoal.condition,
            iteration: preEvalGoal.iterations,
            runningBackgroundTasks: runningBg,
          };
          return;
        }
        const goalResult = errorEmittedThisTurn
          ? null
          : yield* evaluateGoal({
              session: host.deps.session,
              config: host.deps.config,
              ctx: makeRequestContext(host.deps, host.currentTurnId ?? undefined),
              cancelled: () => isCancelled(),
              ...(controller.signal ? { abortSignal: controller.signal } : {}),
            });
        const stopHookBlocked = yield* fireStopPromptHooks(turnStreamDeps(host), controller.signal);
        const goal = getActiveGoal(host.deps.session.id);
        if (goal && !errorEmittedThisTurn && !isCancelled() && !controller.signal.aborted) {
          goalContinueCount += 1;
          if (goalContinueCount > stopHookBlockCap()) {
            const goalMsg = `goal remained unmet for ${goalContinueCount} continuations; halting to avoid a loop (cap ${stopHookBlockCap()}, set OTHERSIDE_STOP_HOOK_BLOCK_CAP to change)`;
            const goalMeta = loopErrorMeta({
              message: goalMsg,
              provider: turnState.provider,
              model: turnState.model,
              attempt: goalContinueCount,
            });
            yield { kind: "error", error: goalMsg, meta: goalMeta };
            return;
          }
          const reason =
            goalResult?.met === false
              ? (goalResult.reason ?? "condition not satisfied")
              : "condition not satisfied";
          host.deps.session.messages.push({
            role: "user",
            content: [
              {
                type: "text",
                text: goalContinuePrompt(goal.condition, reason),
              },
            ],
          });
          yield {
            kind: "goal_continue",
            condition: goal.condition,
            iteration: goal.iterations,
          };
          continue;
        }
        if (
          stopHookBlocked &&
          !errorEmittedThisTurn &&
          !isCancelled() &&
          !controller.signal.aborted
        ) {
          stopHookBlockCount += 1;
          if (stopHookBlockCount > stopHookBlockCap()) {
            const hookMsg = `stop hook blocked ${stopHookBlockCount} times; halting to avoid a loop (cap ${stopHookBlockCap()}, set OTHERSIDE_STOP_HOOK_BLOCK_CAP to change)`;
            const hookMeta = loopErrorMeta({
              message: hookMsg,
              provider: turnState.provider,
              model: turnState.model,
              attempt: stopHookBlockCount,
            });
            yield { kind: "error", error: hookMsg, meta: hookMeta };
            return;
          }
          continue;
        }
        if (isCancelled() || controller.signal.aborted) return;
        const midTurnDrain = emitQueue.drainForBoundary("mid_turn");
        const queuedMessages = host.pendingUserInputDrainer?.() ?? [];
        const hasMidTurnLlmInput = midTurnDrain.llmBlocks.length > 0;
        if (hasMidTurnLlmInput) {
          host.deps.session.messages.push({
            role: "user",
            content: midTurnDrain.llmBlocks,
          });
          appendNotificationRecords(host, midTurnDrain.notificationTexts);
        }

        if (queuedMessages.length > 0) {
          const queuedBlocks: ContentBlock[] = [
            {
              type: "text",
              text: "<system-reminder>\nAdditional user messages arrived while you were working. Address them, but do not abandon the original task unless a new message clearly redirects or cancels it. After handling any side question, continue the original work.\n</system-reminder>",
              reminder_type: "queued_input",
            },
          ];
          for (const msg of queuedMessages) {
            for (const block of msg.blocks) queuedBlocks.push(block);
          }
          host.deps.session.messages.push({
            role: "user",
            content: queuedBlocks,
          });
          yield { kind: "queued_input_drained", messages: queuedMessages };
        }
        // A completion that arrived while the response streamed is now model
        // input. Continue immediately rather than returning idle and leaving
        // that input after the assistant message that caused the drain.
        if (hasMidTurnLlmInput || queuedMessages.length > 0) {
          continue;
        }
        if (
          attempt.producedNothing() &&
          !errorEmittedThisTurn &&
          !isCancelled() &&
          !controller.signal.aborted
        ) {
          consecutiveSilentTurns += 1;
          if (consecutiveSilentTurns > 1) {
            const haltText =
              "Model returned an empty response again after the recovery prompt. Halting to avoid a loop. Try rephrasing your request or switching models.";
            const meta = loopErrorMeta({
              message: haltText,
              provider: turnState.provider,
              model: turnState.model,
              attempt: consecutiveSilentTurns,
            });
            yield { kind: "error", error: haltText, meta };
            return;
          }
          host.deps.session.messages.push({
            role: "user",
            content: [
              {
                type: "text",
                text: "Your last response was empty. Please continue working on the task, or explicitly explain why you cannot.",
              },
            ],
          });
          yield {
            kind: "silent_turn_end_recovery",
            turn,
            iteration: consecutiveSilentTurns,
          };
          continue;
        }
        if (!errorEmittedThisTurn && !isCancelled() && !controller.signal.aborted) {
          yield* maybeCompact(compactDepsFor(host));
        }
        return;
      }

      const ctx = makeRequestContext(host.deps, host.currentTurnId ?? undefined);
      const dispatchStatus = yield* dispatchTurnToolCalls({
        host,
        controller,
        toolCalls: attempt.toolCalls,
        ctx,
      });
      if (dispatchStatus === "stop") return;
      if (!isCancelled() && !controller.signal.aborted) {
        for (const text of await collectRecallReminders(memoryRecall)) {
          host.deps.session.messages.push({
            role: "user",
            content: [{ type: "text", text }],
          });
        }
      }
      if (isCancelled()) return;
    }
  } catch (err) {
    if (isCancelled()) return;
    throw err;
  } finally {
    memoryRecall?.abort();
    // A superseded (zombie) invocation must not flip turn-active state back off
    // out from under the turn that superseded it — see the epoch comment above.
    if (!isSuperseded(host, turnEpoch)) {
      emitQueue.setTurnActive(false);
      setStopHookActiveTurn(false);
    }
    if (host.activeAbortController === controller) host.activeAbortController = null;
  }
}
