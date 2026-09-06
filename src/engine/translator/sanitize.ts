import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";

export function sanitizeMessages(
  messages: Message[],
  options?: { preserveToolReferences?: boolean; declaredToolNames?: ReadonlySet<string> },
): Message[] {
  const declared = collectDeclaredToolUseIds(messages);
  const filtered = filterUnknownToolResults(messages, declared);
  // A tool_reference block is validated against THIS request's declared
  // toolset at the provider boundary, so preserving may only keep references
  // whose tool is actually declared for this request. An inherited transcript
  // (e.g. a context-inheriting fork) can carry references to tools the child
  // never declares (fork-disallowed or not re-announced); those must be
  // stripped from the outgoing body — the persisted transcript is untouched.
  const keepReference = options?.preserveToolReferences
    ? (name: string) => options.declaredToolNames?.has(name) ?? true
    : () => false;
  const providerSafe = filterToolReferenceContent(filtered, keepReference);
  const repaired = injectOrphanInterrupts(providerSafe);
  const grouped = coalesceConsecutiveSameRole(repaired);
  const withoutOrphanThinking = dropThinkingOnlyAssistants(grouped);
  const withoutTrailingThinking = dropTrailingThinkingFromLastAssistant(withoutOrphanThinking);
  const withoutWhitespace = dropWhitespaceOnlyAssistants(withoutTrailingThinking);
  const withContent = fillEmptyNonFinalAssistants(withoutWhitespace);
  return coalesceConsecutiveSameRole(withContent);
}

// The API rejects any thinking block in the latest assistant message that no
// longer matches the response that produced its signature. On resume, records
// are rebuilt from disk and an interrupt or an interleaved user/attachment can
// leave a thinking block stranded away from the text/tool_use it belongs to —
// as a thinking-only assistant message, a trailing thinking block, or a
// whitespace-only fragment left by a mid-stream cancel. These passes drop those
// artifacts so a resumed turn never ships a stale or ill-positioned thinking
// block. A block sitting in a valid position is never rewritten, only dropped.
const NO_ASSISTANT_CONTENT = "[No message content]";

function isThinkingBlock(block: ContentBlock): boolean {
  return block.type === "thinking";
}

function dropThinkingOnlyAssistants(messages: Message[]): Message[] {
  return messages.filter((msg) => {
    if (msg.role !== "assistant" || msg.content.length === 0) return true;
    return !msg.content.every(isThinkingBlock);
  });
}

function dropTrailingThinkingFromLastAssistant(messages: Message[]): Message[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return messages;
  const tail = last.content[last.content.length - 1];
  if (!tail || !isThinkingBlock(tail)) return messages;
  let end = last.content.length;
  while (end > 0) {
    const block = last.content[end - 1];
    if (!block || !isThinkingBlock(block)) break;
    end -= 1;
  }
  const kept: ContentBlock[] =
    end <= 0 ? [{ type: "text", text: NO_ASSISTANT_CONTENT }] : last.content.slice(0, end);
  const out = [...messages];
  out[out.length - 1] = { ...last, content: kept };
  return out;
}

function dropWhitespaceOnlyAssistants(messages: Message[]): Message[] {
  return messages.filter((msg) => {
    if (msg.role !== "assistant" || msg.content.length === 0) return true;
    return !msg.content.every((block) => block.type === "text" && block.text.trim() === "");
  });
}

function fillEmptyNonFinalAssistants(messages: Message[]): Message[] {
  const lastIndex = messages.length - 1;
  return messages.map((msg, index) => {
    if (msg.role !== "assistant" || index === lastIndex || msg.content.length > 0) return msg;
    return { ...msg, content: [{ type: "text", text: NO_ASSISTANT_CONTENT }] };
  });
}

function filterToolReferenceContent(
  messages: Message[],
  keepReference: (toolName: string) => boolean,
): Message[] {
  return messages.map((msg) => {
    let changed = false;
    const content = msg.content.map((block) => {
      if (block.type !== "tool_result" || !Array.isArray(block.content)) return block;
      const kept = block.content.filter(
        (part) => part.type !== "tool_reference" || keepReference(part.tool_name),
      );
      if (kept.length === block.content.length) return block;
      changed = true;
      return { ...block, content: kept.length > 0 ? kept : "" };
    });
    return changed ? { ...msg, content } : msg;
  });
}

function collectDeclaredToolUseIds(messages: Message[]): Set<string> {
  const declared = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") declared.add(block.id);
    }
  }
  return declared;
}

function filterUnknownToolResults(messages: Message[], declared: Set<string>): Message[] {
  const filtered: Message[] = [];
  for (const msg of messages) {
    if (msg.role !== "user") {
      filtered.push(msg);
      continue;
    }
    const kept = msg.content.filter(
      (block) => block.type !== "tool_result" || declared.has(block.tool_use_id),
    );
    if (kept.length > 0) filtered.push({ ...msg, content: kept });
  }
  return filtered;
}

function injectOrphanInterrupts(messages: Message[]): Message[] {
  const resultById = new Map<string, Extract<ContentBlock, { type: "tool_result" }>>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool_result") resultById.set(block.tool_use_id, block);
    }
  }

  const out: Message[] = [];
  const relocated = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== "assistant") {
      const kept = msg.content.filter(
        (b) => b.type !== "tool_result" || !relocated.has(b.tool_use_id),
      );
      if (kept.length === msg.content.length) out.push(msg);
      else if (kept.length > 0) out.push({ ...msg, content: kept });
      continue;
    }

    out.push(msg);
    const toolUseIds = msg.content
      .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
      .map((b) => b.id);
    if (toolUseIds.length === 0) continue;

    const pairs: ContentBlock[] = toolUseIds.map((id) => {
      const existing = resultById.get(id);
      if (existing) {
        relocated.add(id);
        return existing;
      }
      return {
        type: "tool_result" as const,
        tool_use_id: id,
        content: "Interrupted by user",
        is_error: true,
      };
    });
    out.push({ role: "user", content: pairs });
  }
  return out;
}

function coalesceConsecutiveSameRole(messages: Message[]): Message[] {
  if (messages.length < 2) return messages;
  const out: Message[] = [];
  for (const msg of messages) {
    const last = out[out.length - 1];
    if (last && last.role === msg.role) {
      out[out.length - 1] = { ...last, content: [...last.content, ...msg.content] };
    } else {
      out.push(msg);
    }
  }
  return out;
}
