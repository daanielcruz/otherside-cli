import { danglingToolResultPlaceholders } from "@/engine/background/subagents/fork/builder.ts";
import * as providers from "@/engine/providers/registry.ts";
import { currentLocalISODate } from "@/engine/queue/runtime/turn-prompts.ts";
import {
  assembleProviderTurn,
  getAssembledTurn,
  sanitizeMessages,
} from "@/engine/translator/index.ts";
import type { ProviderToolDeclaration } from "@/engine/translator/types.ts";
import {
  SIDE_QUESTION_MAX_ATTEMPTS,
  streamWithRetry,
} from "@/engine/transport/_infra/classify/retry.ts";
import { makeQueue } from "@/harness/composer/queue.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export interface SideQuestionUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface SideQuestionRetry {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
}

export interface SideQuestionResult {
  response: string | null;
  synthetic: boolean;
  aborted: boolean;
  usage: SideQuestionUsage;
}

export interface SideQuestionHistoryEntry {
  question: string;
  response: string;
}

export interface SideQuestionInvocation {
  question: string;
  ctx: RequestContext;
  parentSessionId: string;
  parentMessages: readonly Message[];
  config: UserConfig;
  history: SideQuestionHistoryEntry[];
  signal: AbortSignal;
  syntheticSessionId?: string;
  onRetry?: (event: SideQuestionRetry) => void;
  onUsage?: (usage: SideQuestionUsage) => void;
}

const SIDE_QUESTION_REMINDER = [
  "<system-reminder>This is a side question from the user. You must answer this question directly in a single response.",
  "",
  "IMPORTANT CONTEXT:",
  "- You are a separate, lightweight agent spawned to answer this one question",
  "- The main agent is NOT interrupted - it continues working independently in the background",
  "- You share the conversation context but are a completely separate instance",
  '- Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect',
  "",
  "CRITICAL CONSTRAINTS:",
  "- You have NO tools available - you cannot read files, run commands, search, or take any actions",
  "- This is a one-off response - there will be no follow-up turns",
  "- You can ONLY provide information based on what you already know from the conversation context",
  '- NEVER say things like "Let me try...", "I\'ll now...", "Let me check...", or promise to take any action',
  "- If you don't know the answer, say so - do not offer to look it up or investigate",
  "",
  "Simply answer the question with the information you have.</system-reminder>",
].join("\n");

interface SideQuestionConversationArgs {
  parentMessages: readonly Message[];
  history: SideQuestionHistoryEntry[];
  provider: ProviderId;
  wrappedQuestion: string;
}

function sideQuestionConversation(args: SideQuestionConversationArgs): Message[] {
  let placeholders = danglingToolResultPlaceholders(args.parentMessages);
  const takePlaceholders = (): ContentBlock[] => {
    const taken = placeholders;
    placeholders = [];
    return taken;
  };
  const out: Message[] = [...args.parentMessages];
  for (const turn of args.history) {
    out.push({
      role: "user",
      content: [...takePlaceholders(), { type: "text", text: turn.question }],
    });
    out.push({
      role: "assistant",
      content: [{ type: "text", text: turn.response }],
      producedBy: args.provider,
    });
  }
  out.push({
    role: "user",
    content: [...takePlaceholders(), { type: "text", text: args.wrappedQuestion }],
  });
  return out;
}

interface SideQuestionRequest {
  messages: Message[];
  tools: ProviderToolDeclaration[];
}

export async function askSideQuestion(params: SideQuestionInvocation): Promise<SideQuestionResult> {
  const {
    question,
    ctx,
    parentSessionId,
    parentMessages,
    config,
    history,
    signal,
    syntheticSessionId,
    onRetry,
    onUsage,
  } = params;
  const provider = providers.get(ctx.provider);
  const childCtx: RequestContext = {
    ...ctx,
    abortSignal: signal,
    sessionId: syntheticSessionId ?? ctx.sessionId,
    cacheRole: "side-question",
  };

  const conversation = sideQuestionConversation({
    parentMessages,
    history,
    provider: ctx.provider,
    wrappedQuestion: `${SIDE_QUESTION_REMINDER}\n\n${question}`,
  });

  const fallbackRequest = (): SideQuestionRequest => {
    const turn = assembleProviderTurn({
      ctx: { ...childCtx, sessionId: parentSessionId },
      provider,
      messages: conversation,
      injections: makeQueue(),
      config,
      currentDate: currentLocalISODate(),
    });
    return { messages: turn.messages, tools: turn.tools };
  };

  const parentTurn = getAssembledTurn(parentSessionId);
  const request: SideQuestionRequest = parentTurn
    ? {
        messages: provider.composeMessages(parentTurn.harness, sanitizeMessages(conversation)),
        tools: parentTurn.tools,
      }
    : fallbackRequest();

  const reqBody = provider.translateRequest(childCtx, request.messages, request.tools);
  const stream = streamWithRetry(childCtx, provider, reqBody, {
    maxAttempts: SIDE_QUESTION_MAX_ATTEMPTS,
  });

  let text = "";
  let toolCallName: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    for await (const ev of stream) {
      if (signal.aborted) break;
      if (ev.kind === "text_delta") {
        text += ev.text;
      } else if (ev.kind === "tool_call_complete") {
        toolCallName = ev.name;
      } else if (ev.kind === "usage") {
        if (ev.inputTokens !== undefined) inputTokens = ev.inputTokens;
        if (ev.outputTokens !== undefined) outputTokens = ev.outputTokens;
      } else if (ev.kind === "retry_status") {
        onRetry?.({
          attempt: ev.attempt,
          maxAttempts: ev.maxAttempts,
          delayMs: ev.delayMs,
          reason: ev.reason,
        });
      } else if (ev.kind === "stream_reset") {
        text = "";
        toolCallName = null;
      } else if (ev.kind === "error") {
        return abortedResult(false, { inputTokens, outputTokens });
      }
    }
  } catch (err) {
    if (signal.aborted) return abortedResult(true, { inputTokens, outputTokens });
    throw err;
  }

  const usage: SideQuestionUsage = { inputTokens, outputTokens };
  if (inputTokens > 0 || outputTokens > 0) onUsage?.(usage);

  if (signal.aborted) return abortedResult(true, usage);

  const trimmed = text.trim();
  if (trimmed.length > 0) {
    return { response: trimmed, synthetic: false, aborted: false, usage };
  }
  if (toolCallName !== null) {
    return {
      response: `(The model tried to call ${toolCallName} instead of answering directly. Try rephrasing or ask in the main conversation.)`,
      synthetic: true,
      aborted: false,
      usage,
    };
  }
  return { response: null, synthetic: false, aborted: false, usage };
}

function abortedResult(aborted: boolean, usage: SideQuestionUsage): SideQuestionResult {
  return { response: null, synthetic: false, aborted, usage };
}
