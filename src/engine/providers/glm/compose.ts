import type { ComposedHarness, SystemTextBlock } from "@/harness/composer/injections.ts";
import type { CacheControl, ContentBlock, Message } from "@/kernel/std/types/message.ts";

// ZCode's captured wire tags every system text block `{type:"ephemeral"}` —
// no `ttl`, no `scope` (those are Anthropic 1h/global extensions GLM's wire
// doesn't show). Bare ephemeral is the only shape GLM ever emits.
const GLM_EPHEMERAL: CacheControl = { type: "ephemeral" };

// Harness layers arrive as many small fragments (base instructions, tool
// guidance, memory, cwd, git status, ultracode reminders, ...). Cache-tagging
// each one individually burns through the Anthropic-family cache-breakpoint
// budget for zero benefit. Fold them into a small, bounded set — static-phase
// content into one block, dynamic-phase into another — mirroring the
// consolidation the Anthropic provider already does for the same reason.
function consolidateGlmSystemBlocks(blocks: SystemTextBlock[]): ContentBlock[] {
  if (blocks.length === 0) return [];
  const staticParts: string[] = [];
  const dynamicParts: string[] = [];
  for (const b of blocks) {
    if (b.phase === "dynamic") dynamicParts.push(b.text);
    else staticParts.push(b.text);
  }
  const out: ContentBlock[] = [];
  const staticJoined = staticParts.join("\n\n");
  if (staticJoined) out.push({ type: "text", text: staticJoined, cache_control: GLM_EPHEMERAL });
  const dynamicJoined = dynamicParts.join("\n\n");
  if (dynamicJoined) out.push({ type: "text", text: dynamicJoined, cache_control: GLM_EPHEMERAL });
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
        msg.content[j] = { ...block, cache_control: GLM_EPHEMERAL };
        return;
      }
    }
  }
}

export function composeGlmMessages(harness: ComposedHarness, history: Message[]): Message[] {
  const out: Message[] = [];
  const systemBlocks = consolidateGlmSystemBlocks(harness.systemBlocks);
  if (systemBlocks.length > 0) {
    out.push({ role: "system", content: systemBlocks });
  } else if (harness.combined.length > 0) {
    out.push({
      role: "system",
      content: [{ type: "text", text: harness.combined, cache_control: GLM_EPHEMERAL }],
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
  // ZCode's own beta name (mid-conversation-system-2026-04-07) exists to
  // carry a role:"system" message mid-array on later turns (confirmed in
  // FINGERPRINT-SUMMARY.md capture notes) — emit it the same way Anthropic
  // does rather than dropping mid-turn system content on the floor.
  const midSystemBlocks = harness.midSystemBlocks ?? [];
  if (midSystemBlocks.length > 0) {
    const midJoined = midSystemBlocks.map((b) => b.text).join("\n\n");
    if (midJoined) {
      const firstUserIndex = out.findIndex((m) => m.role === "user");
      const midSystemMessage: Message = {
        role: "system",
        content: [{ type: "text", text: midJoined }],
      };
      if (firstUserIndex >= 0) out.splice(firstUserIndex + 1, 0, midSystemMessage);
      else out.push(midSystemMessage);
    }
  }
  return out;
}
