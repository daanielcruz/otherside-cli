import { dequeue } from "@/engine/agents/inbox.ts";
import {
  isWorkflowEnabled,
  isWorkflowKeywordTriggerEnabled,
} from "@/engine/background/workflows/runtime/gate.ts";
import {
  nextUltracodeReminder,
  ULTRACODE_ENTER_FULL,
  ULTRACODE_ENTER_SPARSE,
  ULTRACODE_EXIT,
  ULTRACODE_KEYWORD_REQUEST,
} from "@/engine/queue/runtime/markers.ts";
import {
  type MemoryRecallPrefetch,
  startMemoryRecallPrefetch,
} from "@/engine/queue/runtime/prefetch.ts";
import { makeRequestContext } from "@/engine/queue/runtime/request-context.ts";
import { hasUltracodeKeyword } from "@/engine/queue/runtime/ultracode-directive.ts";
import { appendRecord } from "@/engine/session/index.ts";
import { outputStyleTurnReminder } from "@/harness/routines/output-styles/built-in.ts";
import type { AgentEvent, DrainedQueuedMessage } from "@/kernel/std/types/events.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";
import { planModeReminder } from "./plan-reminders.ts";
import type { TurnLoopHost } from "./types.ts";

export interface TurnOpening {
  /** False when the turn has nothing to send and the loop should return idle. */
  proceed: boolean;
  memoryRecall: MemoryRecallPrefetch | undefined;
  turnState: ReturnType<TurnLoopHost["deps"]["broker"]["read"]>;
}

/**
 * Assembles the turn's opening user message: queued input, inbox and pending
 * injections, the plan-mode reminder, the typed prompt, ultracode reminders,
 * and the memory-recall prefetch keyed off the prompt text. Pushes everything
 * onto the session and reports whether the turn owes the model a response.
 */
export function* openTurnPrompt(input: {
  host: TurnLoopHost;
  userInput: string | ContentBlock[];
  keywordText: string | undefined;
  initialQueuedMessages: DrainedQueuedMessage[];
  turnStartPushedMessages: boolean;
  abortSignal: AbortSignal;
}): Generator<AgentEvent, TurnOpening> {
  const { host, userInput, keywordText, initialQueuedMessages, turnStartPushedMessages } = input;
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
  if (
    inputBlocks.length > 0 &&
    isWorkflowEnabled(host.deps.config) &&
    isWorkflowKeywordTriggerEnabled(host.deps.config)
  ) {
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
  // The active style restates itself on every typed turn; built-ins only.
  if (inputBlocks.length > 0) {
    const styleReminder = outputStyleTurnReminder(host.deps.config.outputStyle);
    if (styleReminder !== null) reminderTexts.push(styleReminder);
  }
  const injectionBlocks: ContentBlock[] =
    pendingInjections.length > 0 ? [{ type: "text", text: pendingInjections.join("\n\n") }] : [];
  const finalBlocks = [...injectionBlocks, ...inputBlocks];
  // turn-start drain (urgent_output, deferred_output via emit-queue) was already
  // pushed to session.messages by the caller; if it landed, we MUST keep going
  // even when finalBlocks is empty — the LLM has new content to respond to.
  // Without this, an auto-resume on workflow completion no-ops and the user has
  // to type to wake the loop.
  const priorMessages = host.deps.session.messages;
  const lastPriorMessage = priorMessages[priorMessages.length - 1];
  const owesAssistantResponse = lastPriorMessage?.role === "user";
  if (finalBlocks.length === 0 && !turnStartPushedMessages && !owesAssistantResponse) {
    return { proceed: false, memoryRecall: undefined, turnState };
  }
  if (finalBlocks.length > 0) {
    host.deps.session.messages.push({ role: "user", content: finalBlocks });
  }
  for (const text of reminderTexts) {
    host.deps.session.messages.push({
      role: "user",
      content: [{ type: "text", text: `<system-reminder>\n${text}\n</system-reminder>` }],
    });
  }
  let memoryRecall: MemoryRecallPrefetch | undefined;
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
      parentSignal: input.abortSignal,
    });
  }
  return { proceed: true, memoryRecall, turnState };
}

function drainInbox(host: TurnLoopHost): void {
  while (true) {
    const msg = dequeue(host.deps.session.id);
    if (!msg) break;
    const replyTag = msg.replyTo ? ` (reply to ${msg.replyTo})` : "";
    host.injections.push(`[inbox from ${msg.from ?? "unknown"}${replyTag}]\n${msg.message}`);
  }
}
