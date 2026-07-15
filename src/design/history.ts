import type { DesignSnapshot, PersistedToolCard } from "@/design/types.ts";
import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";

/**
 * A prior conversation message as the design bridge sees it (system messages
 * are filtered out by the caller; only user/assistant text reaches replay).
 */
export interface DesignHistoryMessage {
  role: string;
  content: string;
}

/**
 * Budget for the serialized replayed history handed to the fork as
 * `initialMessages`. When a history exceeds it, older turns degrade to
 * text-only (their tool blocks are dropped) and then whole oldest turns are
 * dropped — but the most recent two turns always keep their full structure.
 */
export const DESIGN_HISTORY_CHAR_CAP = 120_000;

// One user-turn of replayable history: the user message, optional tool_use /
// tool_result exchange recorded for that turn, and the assistant reply text.
interface TurnChunk {
  full: Message[];
  textOnly: Message[];
  useTextOnly: boolean;
  dropped: boolean;
}

function textMessage(role: "user" | "assistant", text: string): Message {
  return { role, content: [{ type: "text", text }] };
}

// Persisted inputs are truncated at write time, so a large input may no longer
// be valid JSON — replay it as {} rather than failing the whole turn.
function parsePersistedInput(input: string | undefined): unknown {
  if (input === undefined) return {};
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}

// Mirrors the shape sessionRecordsToMessages produces for a tool exchange:
// one assistant message carrying the tool_use blocks, then one user message
// carrying the paired tool_result blocks in the same order.
function toolExchangeMessages(cards: PersistedToolCard[]): Message[] {
  const toolUses: ContentBlock[] = cards.map((card) => ({
    type: "tool_use",
    id: card.toolUseId ?? card.id,
    name: card.name,
    input: parsePersistedInput(card.input),
  }));
  const toolResults: ContentBlock[] = cards.map((card) => ({
    type: "tool_result",
    tool_use_id: card.toolUseId ?? card.id,
    content: card.output ?? "(result not recorded)",
    ...(card.isError === true || card.phase === "error" ? { is_error: true } : {}),
  }));
  return [
    { role: "assistant", content: toolUses },
    { role: "user", content: toolResults },
  ];
}

function splitTurns(
  snapshot: DesignSnapshot | undefined,
  messages: DesignHistoryMessage[],
): TurnChunk[] {
  const cards = snapshot?.tools ?? [];
  const chunks: TurnChunk[] = [];
  let turnIndex = -1;
  for (const message of messages) {
    if (message.role === "user") {
      turnIndex += 1;
      const chunk: TurnChunk = { full: [], textOnly: [], useTextOnly: false, dropped: false };
      const userMessage = textMessage("user", message.content);
      chunk.full.push(userMessage);
      chunk.textOnly.push(userMessage);
      // Verifier-lane cards belong to the background verifier fork, not the
      // design fork — replaying them here would inject tool_use blocks for
      // tools the design fork does not have.
      const turnCards = cards.filter(
        (card) => card.turnIndex === turnIndex && card.lane !== "verifier",
      );
      if (turnCards.length > 0) chunk.full.push(...toolExchangeMessages(turnCards));
      chunks.push(chunk);
      continue;
    }
    if (message.role !== "assistant") continue;
    // An assistant message before any user message (unusual) still gets a chunk
    // so it survives replay; it simply carries no tool exchange.
    let chunk = chunks[chunks.length - 1];
    if (!chunk) {
      chunk = { full: [], textOnly: [], useTextOnly: false, dropped: false };
      chunks.push(chunk);
    }
    const assistantMessage = textMessage("assistant", message.content);
    chunk.full.push(assistantMessage);
    chunk.textOnly.push(assistantMessage);
  }
  return chunks;
}

/**
 * Reconstruct prior completed turns as structured `Message[]` for the fork's
 * `initialMessages`. Turns whose tool cards were persisted replay as real
 * tool_use/tool_result exchanges; turns without recorded tools (or from
 * snapshots predating structured persistence) replay as plain text.
 */
export function buildDesignHistory(
  snapshot: DesignSnapshot | undefined,
  messages: DesignHistoryMessage[],
  cap: number = DESIGN_HISTORY_CHAR_CAP,
): Message[] {
  const chunks = splitTurns(snapshot, messages);
  const render = (): Message[] =>
    chunks
      .filter((chunk) => !chunk.dropped)
      .flatMap((chunk) => (chunk.useTextOnly ? chunk.textOnly : chunk.full));
  const overCap = (): boolean => JSON.stringify(render()).length > cap;
  // The most recent two turns keep their full structure no matter what.
  const trimmable = Math.max(0, chunks.length - 2);
  for (let i = 0; i < trimmable && overCap(); i += 1) {
    const chunk = chunks[i];
    if (chunk) chunk.useTextOnly = true;
  }
  for (let i = 0; i < trimmable && overCap(); i += 1) {
    const chunk = chunks[i];
    if (chunk) chunk.dropped = true;
  }
  return render();
}
