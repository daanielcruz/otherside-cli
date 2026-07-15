import { recordCodexRawReplayDiagnostic } from "@/devtools/codex-raw-stream.ts";
import { auxiliaryModelFor } from "@/engine/model/tier/tiers.ts";
import * as providers from "@/engine/providers/registry.ts";
import { sanitizeMessages } from "@/engine/translator/index.ts";
import { streamWithRetry } from "@/engine/transport/_infra/classify/retry.ts";
import type { ComposedHarness } from "@/harness/composer/injections.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { parseSelectionResponse } from "./parse.ts";
import { formatMemoryManifest, type MemoryHeader, scanMemoryFiles } from "./scan.ts";

export const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to Otherside CLI as it processes a user's query. The first message lists the available memory files with their filenames and descriptions; subsequent messages each contain one user query.

Return a list of filenames for the memories that will clearly be useful to Otherside CLI as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- Be especially conservative with user-profile and project-overview memories ([user], [project]). These describe the user's ongoing focus, not what every question is about. A profile saying "works on DB performance" is NOT relevant to a question that merely contains the word "performance" unless the question is actually about that DB work. Match on what the question IS ABOUT, not on surface keyword overlap with who the user is.
- Do not re-select memories you already returned for an earlier query in this conversation.
`;

const SELECTION_MAX_TOKENS = 256;

export interface RecallConversation {
  memories: MemoryHeader[];
  messages: Message[];
}

export interface RecallState {
  byDir: Record<string, RecallConversation | undefined>;
  surfacedPaths: Set<string>;
  surfacedBytes: number;
}

export function createRecallState(): RecallState {
  return { byDir: {}, surfacedPaths: new Set(), surfacedBytes: 0 };
}

async function ensureConversation(
  state: RecallState,
  memoryDir: string,
  signal: AbortSignal,
): Promise<RecallConversation | undefined> {
  const cached = state.byDir[memoryDir];
  if (cached) return cached;
  const memories = await scanMemoryFiles(memoryDir, signal);
  if (memories.length === 0 || signal.aborted) return undefined;
  const conversation: RecallConversation = {
    memories,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: `Available memories:\n${formatMemoryManifest(memories)}` }],
      },
    ],
  };
  state.byDir[memoryDir] = conversation;
  return conversation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SELECTION_OUTPUT_CONFIG = {
  format: {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        selected_memories: { type: "array", items: { type: "string" } },
      },
      required: ["selected_memories"],
      additionalProperties: false,
    },
  },
};

export function clampSelectionRequest(body: unknown): unknown {
  if (!isRecord(body)) return body;
  const next = { ...body };

  if ("contents" in next && "generationConfig" in next && isRecord(next.generationConfig)) {
    const genConfig = { ...next.generationConfig };
    genConfig.maxOutputTokens =
      typeof genConfig.maxOutputTokens === "number"
        ? Math.min(genConfig.maxOutputTokens, SELECTION_MAX_TOKENS)
        : SELECTION_MAX_TOKENS;
    if (isRecord(genConfig.thinkingConfig)) {
      genConfig.thinkingConfig = { ...genConfig.thinkingConfig, thinkingBudget: 0 };
    }
    genConfig.responseMimeType = "application/json";
    genConfig.responseSchema = {
      type: "OBJECT",
      properties: {
        selected_memories: { type: "ARRAY", items: { type: "STRING" } },
      },
      required: ["selected_memories"],
    };
    next.generationConfig = genConfig;
    next.tools = [];
    return next;
  }

  next.max_tokens =
    typeof next.max_tokens === "number"
      ? Math.min(next.max_tokens, SELECTION_MAX_TOKENS)
      : SELECTION_MAX_TOKENS;
  next.thinking = { type: "disabled" };
  next.tools = [];
  next.output_config = SELECTION_OUTPUT_CONFIG;
  return next;
}

async function runSelectionQuery(
  query: string,
  conversation: RecallConversation,
  ctx: RequestContext,
  signal: AbortSignal,
): Promise<string[]> {
  const byFilename = new Map(conversation.memories.map((m) => [m.filename, m]));
  const userText = `Select memories relevant to:\n${query}`;
  recordCodexRawReplayDiagnostic({
    event: "memory_select_start",
    query,
    memories: conversation.memories.length,
    sessionId: ctx.sessionId,
  });
  try {
    const auxModel = auxiliaryModelFor(ctx.provider);
    const selectCtx: RequestContext = {
      ...ctx,
      model: auxModel === "inherit" ? ctx.model : auxModel,
      agentic: false,
      effort: null,
      disableThinking: true,
      requestRole: "memory_recall",
      abortSignal: signal,
    };
    const provider = providers.get(selectCtx.provider);
    const harness: ComposedHarness = {
      layers: [{ name: "memory-recall-select", body: SELECT_MEMORIES_SYSTEM_PROMPT }],
      combined: SELECT_MEMORIES_SYSTEM_PROMPT,
      systemBlocks: [{ text: SELECT_MEMORIES_SYSTEM_PROMPT }],
      userPrepend: [],
    };
    const messages: Message[] = [
      ...conversation.messages,
      { role: "user", content: [{ type: "text", text: userText }] },
    ];
    const composed = provider.composeMessages(harness, sanitizeMessages(messages));
    const body = clampSelectionRequest(provider.translateRequest(selectCtx, composed, []));
    recordCodexRawReplayDiagnostic({
      event: "memory_select_request",
      model: selectCtx.model,
      sessionId: ctx.sessionId,
    });
    let responseText = "";
    for await (const ev of streamWithRetry(selectCtx, provider, body)) {
      if (ev.kind === "text_delta") responseText += ev.text;
      else if (ev.kind === "stream_reset") responseText = "";
      else if (ev.kind === "error" || ev.kind === "quota_exhausted") return [];
      else if (ev.kind === "message_stop") break;
    }
    const selected = parseSelectionResponse(responseText);
    recordCodexRawReplayDiagnostic({
      event: "memory_select_end",
      responseBytes: Buffer.byteLength(responseText, "utf8"),
      parsed: selected !== null,
      sessionId: ctx.sessionId,
    });
    if (selected === null) return [];
    conversation.messages = [
      ...conversation.messages,
      { role: "user", content: [{ type: "text", text: userText }] },
      { role: "assistant", content: [{ type: "text", text: responseText }] },
    ];
    return selected.filter((f) => byFilename.has(f));
  } catch (error) {
    recordCodexRawReplayDiagnostic({
      event: "memory_select_error",
      error: error instanceof Error ? error.message : String(error),
      sessionId: ctx.sessionId,
    });
    return [];
  }
}

export interface RelevantMemory {
  path: string;
  mtimeMs: number;
}

export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  state: RecallState,
  ctx: RequestContext,
  signal: AbortSignal,
): Promise<RelevantMemory[]> {
  const conversation = await ensureConversation(state, memoryDir, signal);
  if (!conversation || conversation.memories.every((m) => state.surfacedPaths.has(m.filePath))) {
    return [];
  }
  const byFilename = new Map(conversation.memories.map((m) => [m.filename, m]));
  const selected = await runSelectionQuery(query, conversation, ctx, signal);
  return selected
    .map((filename) => byFilename.get(filename))
    .filter((m): m is MemoryHeader => m !== undefined && !state.surfacedPaths.has(m.filePath))
    .map((m) => ({ path: m.filePath, mtimeMs: m.mtimeMs }));
}
