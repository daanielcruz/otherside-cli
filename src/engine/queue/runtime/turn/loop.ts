import { existsSync } from "node:fs";
import { recordCodexRawReplayDiagnostic } from "@/devtools/codex-raw-stream.ts";
import { dequeue } from "@/engine/agents/inbox.ts";
import { listRunning as bgListRunning } from "@/engine/background/tasks/background.ts";
import { isWorkflowEnabled } from "@/engine/background/workflows/runtime/gate.ts";
import { listWorkflowTasks } from "@/engine/background/workflows/runtime/store/store.ts";
import { recordTurnCacheUsage } from "@/engine/providers/_shared/cache.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import { hasUltracodeKeyword } from "@/engine/queue/runtime/keyword.ts";
import {
  nextUltracodeReminder,
  ULTRACODE_ENTER_FULL,
  ULTRACODE_ENTER_SPARSE,
  ULTRACODE_EXIT,
  ULTRACODE_KEYWORD_REQUEST,
} from "@/engine/queue/runtime/markers.ts";
import {
  collectRecallReminders,
  type MemoryRecallPrefetch,
  startMemoryRecallPrefetch,
} from "@/engine/queue/runtime/prefetch.ts";
import { getActiveGoal } from "@/engine/queue/state.ts";
import { appendRecord } from "@/engine/session/index.ts";
import { activePlanFilePath } from "@/engine/tools/plan-gate.ts";
import { classifyError } from "@/engine/transport/_infra/classify/error-classifier.ts";
import { uuidv4 } from "@/kernel/std/id.ts";
import type { AgentEvent } from "@/kernel/std/types/events.ts";
import { type ContentBlock, type ToolCall } from "@/kernel/std/types/message.ts";
import type { CompactOrchestrationDeps } from "../compact/orchestration.ts";
import {
  checkContextOverflow,
  forceCompactOnOverflow,
  maybeCompact,
  maybeMicroCompact,
} from "../compact/orchestration.ts";
import { evaluateGoal, goalContinuePrompt } from "../goal-evaluation.ts";
import { flushOrphanToolUses } from "../orphan-synth.ts";
import { makeRequestContext } from "../request-context.ts";
import { stopHookBlockCap } from "../stop-hook-classifier.ts";
import { setStopHookActiveTurn } from "../stop-hook-rewake.ts";
import { queuedInputBlocks } from "../turn-prompts.ts";
import { commitAssistantMessage } from "./assistant-commit.ts";
import {
  fireStopPromptHooks,
  mergeUsageSnap,
  openProviderStream,
  turnStreamDeps,
} from "./stream.ts";
import { appendNotificationRecords, dispatchTurnToolCalls } from "./tool-dispatch.ts";
import type { TurnLoopHost } from "./types.ts";

export type { TurnLoopHost } from "./types.ts";

function planModeReminder(sessionId: string): string {
  const planFile = activePlanFilePath(sessionId);
  const planFileInfo = existsSync(planFile)
    ? `A plan file already exists at ${planFile}. You can read it and make incremental edits using the Edit tool.`
    : `No plan file exists yet. You should create your plan at ${planFile} using the Write tool.`;
  return `Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.

## Plan File Info:
${planFileInfo}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

When your plan is ready for approval, call ExitPlanMode.`;
}

const EXITED_PLAN_MODE_REMINDER =
  "## Exited Plan Mode\n\nYou have exited plan mode. You can now make edits, run tools, and take actions.";
const PER_TURN_CHAR_CAP = 200_000;

function runningSessionWorkCount(sessionId: string): number {
  const backgroundTasks = bgListRunning().filter((task) => task.sessionId === sessionId).length;
  const workflows = listWorkflowTasks().filter(
    (task) => task.sessionId === sessionId && task.status === "running",
  ).length;
  return backgroundTasks + workflows;
}

// Per-host turn epoch: a dispatch can be cancelled from the UI (turnGuard.abort())
// while this generator is still parked inside a slow tool whose own abort handling
// has not resolved, leaving a "zombie" invocation suspended. The next
// dispatch calls runTurn() again for the SAME host and resets the shared
// `host.cancelled` flag for ITS OWN turn — which would also un-cancel the zombie's
// view of that flag, since it is one boolean shared across invocations. The epoch
// closes that: each invocation bumps it at start and captures its own value, so a
// zombie's cancellation checks stay true even after a newer turn resets
// `host.cancelled`, and its finally cannot flip shared turn-active state out from
// under the turn that superseded it.
const turnEpochByHost = new WeakMap<TurnLoopHost, number>();

function beginTurnEpoch(host: TurnLoopHost): number {
  const epoch = (turnEpochByHost.get(host) ?? 0) + 1;
  turnEpochByHost.set(host, epoch);
  return epoch;
}

function isSuperseded(host: TurnLoopHost, epoch: number): boolean {
  return turnEpochByHost.get(host) !== epoch;
}

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
    if (initialQueuedMessages.length > 0) {
      yield { kind: "queued_input_drained", messages: initialQueuedMessages };
    }
    drainInbox(host);
    const pendingInjections = host.injections.drain();
    const turnState = host.deps.broker.read();
    if (turnState.permissionMode === "plan") {
      pendingInjections.unshift(
        `<system-reminder>\n${planModeReminder(host.deps.session.id)}\n</system-reminder>`,
      );
    }
    const rawInput: ContentBlock[] =
      typeof userInput === "string"
        ? userInput.length > 0
          ? [{ type: "text", text: userInput }]
          : []
        : userInput;
    const inputBlocks: ContentBlock[] = rawInput.filter(
      (b) => b.type !== "text" || b.text.length > 0,
    );
    // Ultracode reminders evaluate only on the initial regular-user-prompt
    // pass (a turn that starts with real typed input) and only when the
    // Workflow tool is enabled; auto-resumes and tool-loop continuations
    // leave them inert. Each reminder ships as its own user message after
    // the typed prompt, keyword first, then enter/exit.
    const reminderTexts: string[] = [];
    if (inputBlocks.length > 0 && isWorkflowEnabled(host.deps.config)) {
      const keywordSource = keywordText ?? (typeof userInput === "string" ? userInput : null);
      if (keywordSource !== null && hasUltracodeKeyword(keywordSource)) {
        reminderTexts.push(ULTRACODE_KEYWORD_REQUEST);
      }
    }
    if (inputBlocks.length > 0) {
      const ultracodeActive = turnState.ultracode === true && isWorkflowEnabled(host.deps.config);
      const { reminder, enterRecord, exitRecord } = nextUltracodeReminder(
        host.deps.session.records,
        ultracodeActive,
      );
      if (reminder.kind === "enter") {
        reminderTexts.push(
          reminder.reminderType === "full" ? ULTRACODE_ENTER_FULL : ULTRACODE_ENTER_SPARSE,
        );
        if (enterRecord) appendRecord(host.deps.session, enterRecord).catch(() => {});
      } else if (reminder.kind === "exit") {
        reminderTexts.push(ULTRACODE_EXIT);
        if (exitRecord) appendRecord(host.deps.session, exitRecord).catch(() => {});
      }
    }
    const injectionBlocks: ContentBlock[] =
      pendingInjections.length > 0 ? [{ type: "text", text: pendingInjections.join("\n\n") }] : [];
    const finalBlocks = [...injectionBlocks, ...inputBlocks];
    // turn-start drain (urgent_output, deferred_output via emit-queue) was already
    // pushed to session.messages above; if it landed, we MUST keep going even when
    // finalBlocks is empty — the LLM has new content to respond to. Without this,
    // an auto-resume on workflow completion no-ops and the user has to type to
    // wake the loop.
    const priorMessages = host.deps.session.messages;
    const lastPriorMessage = priorMessages[priorMessages.length - 1];
    const owesAssistantResponse = lastPriorMessage?.role === "user";
    if (finalBlocks.length === 0 && !turnStartPushedMessages && !owesAssistantResponse) return;
    if (finalBlocks.length > 0) {
      host.deps.session.messages.push({ role: "user", content: finalBlocks });
    }
    for (const text of reminderTexts) {
      host.deps.session.messages.push({
        role: "user",
        content: [{ type: "text", text: `<system-reminder>\n${text}\n</system-reminder>` }],
      });
    }
    if (inputBlocks.length > 0) {
      const promptText = inputBlocks
        .map((b) => (b.type === "text" ? b.text : ""))
        .filter((t) => t.length > 0)
        .join("\n");
      memoryRecall = startMemoryRecallPrefetch({
        prompt: promptText,
        cwd: host.deps.session.cwd,
        sessionId: host.deps.session.id,
        config: host.deps.config,
        makeCtx: () => makeRequestContext(host.deps, host.currentTurnId ?? undefined),
        parentSignal: controller.signal,
      });
    }

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

      let text = "";
      let thinking = "";
      let thinkingSignature = "";
      const toolCalls: ToolCall[] = [];
      let stopReason = "stop";
      let refusalExplanation: string | undefined;
      let messageId: string | undefined;
      let requestId: string | undefined;
      let charCapTripped = false;
      type UsageSnap = {
        inputTokens: number;
        outputTokens: number;
        cacheCreationInputTokens: number;
        cacheReadInputTokens: number;
      };
      let usageSnap: UsageSnap | null = null;
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
            text += ev.text;
            if (!charCapTripped && text.length > PER_TURN_CHAR_CAP) {
              charCapTripped = true;
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
            thinking += ev.text;
          } else if (ev.kind === "thinking_signature") {
            thinkingSignature = ev.signature;
          } else if (ev.kind === "tool_call_complete") {
            if (!ev.serverHandled) {
              toolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
              recordCodexRawReplayDiagnostic({
                event: "turn_tool_call_complete",
                toolCallId: ev.id,
                toolName: ev.name,
                sessionId: host.deps.session.id,
              });
            }
          } else if (ev.kind === "message_stop") {
            stopReason = ev.stop_reason;
            if (ev.refusal !== undefined) refusalExplanation = ev.refusal;
            recordCodexRawReplayDiagnostic({
              event: "turn_message_stop",
              stopReason,
              toolCalls: toolCalls.map((call) => ({ id: call.id, name: call.name })),
              sessionId: host.deps.session.id,
            });
          } else if (ev.kind === "usage") {
            usageSnap = mergeUsageSnap(usageSnap, ev);
          } else if (ev.kind === "error") {
            errorEmittedThisTurn = true;
          } else if (ev.kind === "retry_status") {
            recordCodexRawReplayDiagnostic({
              event: "turn_retry_status",
              sessionId: host.deps.session.id,
              turn,
              attempt: ev.attempt,
              reason: ev.reason,
            });
          } else if (ev.kind === "quota_exhausted") {
            commitAssistantMessage(
              host.deps,
              text,
              toolCalls,
              thinking,
              thinkingSignature,
              messageId,
              usageSnap ?? undefined,
              requestId,
            );
            host.cancel();
            return;
          } else if (ev.kind === "message_start") {
            if (ev.id !== undefined) messageId = ev.id;
            if (ev.requestId !== undefined) requestId = ev.requestId;
          } else if (ev.kind === "stream_reset") {
            // Partial-content re-send: the provider re-streams this turn from
            // scratch, so discard everything accumulated this attempt — otherwise
            // the committed wire message doubles its text and carries orphaned
            // tool_use blocks (no matching tool_result) that poison later requests.
            text = "";
            thinking = "";
            thinkingSignature = "";
            toolCalls.length = 0;
            usageSnap = null;
            messageId = undefined;
            requestId = undefined;
            stopReason = "stop";
            refusalExplanation = undefined;
            charCapTripped = false;
          }
        }
      } catch (streamError) {
        recordCodexRawReplayDiagnostic({
          event: "turn_stream_error",
          sessionId: host.deps.session.id,
          turn,
          error: streamError instanceof Error ? streamError.message : String(streamError),
          toolCalls: toolCalls.map((call) => ({ id: call.id, name: call.name })),
        });
        throw streamError;
      }
      recordCodexRawReplayDiagnostic({
        event: "turn_stream_closed",
        sessionId: host.deps.session.id,
        turn,
        stopReason,
        toolCalls: toolCalls.map((call) => ({ id: call.id, name: call.name })),
        textBytes: Buffer.byteLength(text, "utf8"),
        errorEmittedThisTurn,
      });

      // A refusal turn carries no usable content; never commit it so it cannot
      // re-send to the model on the next user message (live or after resume).
      if (stopReason !== "refusal") {
        commitAssistantMessage(
          host.deps,
          text,
          toolCalls,
          thinking,
          thinkingSignature,
          messageId,
          usageSnap ?? undefined,
          requestId,
        );
      }

      if (usageSnap) {
        const ctxState = host.deps.broker.read();
        recordTurnCacheUsage(
          ctxState.provider,
          usageSnap.cacheCreationInputTokens,
          usageSnap.cacheReadInputTokens,
        );
      }

      yield { kind: "turn_end", turn, stopReason };

      if (charCapTripped) {
        flushOrphanToolUses(host.deps, toolCalls, "char-cap aborted turn");
        return;
      }

      // Refusal is deterministic — retrying re-refuses. Surface the model's
      // explanation via the retry modal and stop; never recover/retry silently.
      if (stopReason === "refusal") {
        const refusalMsg =
          refusalExplanation && refusalExplanation.trim().length > 0
            ? refusalExplanation
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

      if (stopReason === "tool_calls" && toolCalls.length === 0) {
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

      if (stopReason === "length") {
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

      if (stopReason !== "tool_calls" || toolCalls.length === 0) {
        if (text.trim().length > 0 || toolCalls.length > 0) consecutiveSilentTurns = 0;
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
          text.trim().length === 0 &&
          toolCalls.length === 0 &&
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
      const dispatchStatus = yield* dispatchTurnToolCalls({ host, controller, toolCalls, ctx });
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

function compactDepsFor(host: TurnLoopHost): CompactOrchestrationDeps {
  return {
    agentDeps: host.deps,
    state: host.compactState,
    turnId: host.currentTurnId,
    activeAbortController: () => host.activeAbortController,
    setActiveAbortController: (ctrl) => {
      host.activeAbortController = ctrl;
    },
    injections: host.injections,
    makeCtx: () => makeRequestContext(host.deps, host.currentTurnId ?? undefined),
    clearNestedMemory: () => {
      host.loadedNestedMemoryPaths.clear();
      host.nestedMemoryByPath.clear();
    },
  };
}

function drainInbox(host: TurnLoopHost): void {
  while (true) {
    const msg = dequeue(host.deps.session.id);
    if (!msg) break;
    const replyTag = msg.replyTo ? ` (reply to ${msg.replyTo})` : "";
    host.injections.push(`[inbox from ${msg.from ?? "unknown"}${replyTag}]\n${msg.message}`);
  }
}

function loopErrorMeta(opts: {
  message: string;
  provider: string;
  model: string;
  attempt: number;
}): import("@/engine/transport/error-meta.ts").ErrorMeta {
  const decision: import("@/engine/transport/_infra/classify/classify.ts").RetryDecisionDetailed = {
    kind: "fail",
    reason: opts.message,
    userMessage: opts.message,
  };
  return classifyError({
    err: new Error(opts.message),
    decision,
    provider: opts.provider,
    model: opts.model,
    attempt: opts.attempt,
    source: "turn-loop",
  });
}
