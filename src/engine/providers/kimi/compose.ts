import type { ComposedHarness } from "@/harness/composer/injections.ts";
import type { CacheControl, ContentBlock, Message } from "@/kernel/std/types/message.ts";

const EPHEMERAL: CacheControl = { type: "ephemeral", ttl: "5m" };

export function composeKimiMessages(harness: ComposedHarness, history: Message[]): Message[] {
  const out: Message[] = [];
  if (harness.systemBlocks.length > 0) {
    const blocks: ContentBlock[] = harness.systemBlocks.map((b) => ({
      type: "text" as const,
      text: b.text,
    }));
    const last = blocks[blocks.length - 1];
    if (last && last.type === "text") {
      blocks[blocks.length - 1] = { ...last, cache_control: EPHEMERAL };
    }
    out.push({ role: "system", content: blocks });
  } else if (harness.combined.length > 0) {
    out.push({
      role: "system",
      content: [{ type: "text", text: harness.combined, cache_control: EPHEMERAL }],
    });
  }
  let prependedFirstUser = harness.userPrepend.length === 0;
  for (const msg of history) {
    const stripped = stripUserCacheControl(msg);
    if (!prependedFirstUser && msg.role === "user") {
      const prependBlocks: ContentBlock[] = harness.userPrepend.map((b) => ({
        type: "text",
        text: b.text,
      }));
      out.push({ ...stripped, content: [...prependBlocks, ...stripped.content] });
      prependedFirstUser = true;
    } else {
      out.push(stripped);
    }
  }
  applyLastUserCacheControl(out);
  return out;
}

function stripUserCacheControl(msg: Message): Message {
  if (msg.role !== "user") return msg;
  return {
    ...msg,
    content: msg.content.map((b) => {
      if (b.type === "text" && b.cache_control) return { type: "text", text: b.text };
      return b;
    }),
  };
}

function applyLastUserCacheControl(messages: Message[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "user") continue;
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j];
      if (block && block.type === "text" && block.text.length > 0) {
        msg.content[j] = { ...block, cache_control: EPHEMERAL };
        return;
      }
    }
  }
}
