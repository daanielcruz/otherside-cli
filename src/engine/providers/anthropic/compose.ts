import { CACHE_CONTROL_1H, CACHE_CONTROL_1H_GLOBAL } from "@/engine/transport/cache/index.ts";
import type {
  ComposedHarness,
  MidSystemPromotion,
  SystemTextBlock,
} from "@/harness/composer/injections.ts";
import { stripSystemReminderWrapper } from "@/harness/composer/reminder-wrapper.ts";
import {
  type ContentBlock,
  lastAssistantRequestId,
  type Message,
} from "@/kernel/std/types/message.ts";
import { SYSTEM_OPENER, systemBillingHeader } from "./preamble.ts";

// User-context envelope wrapping structure.
// Wraps the WHOLE bundle ONCE; per-entry separator is a single '\n'.
// The 6-space indent on the IMPORTANT line is part of the wire format.
const BUNDLE_OPEN = "<system-reminder>\n";
const BUNDLE_PREAMBLE = "As you answer the user's questions, you can use the following context:\n";
const BUNDLE_IMPORTANT_LINE =
  "\n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n";
const BUNDLE_CLOSE = "</system-reminder>\n";

// User-context content contains top-level headings (# claudeMd, # currentDate, # gitStatus, etc). Inject it raw to avoid a redundant `# user-context` taxonomy header.
const USER_CONTEXT_BUNDLE_KEY = "user-context";

// The only Anthropic server tool-result block named in this client today.
const SERVER_TOOL_RESULT_TYPES = new Set(["web_search_tool_result"]);

function bundleEntryText(block: SystemTextBlock): string {
  const inner = stripSystemReminderWrapper(block.text);
  const key = block.bundleKey ?? "context";
  if (key === USER_CONTEXT_BUNDLE_KEY) return inner;
  return `# ${key}\n${inner}`;
}

function bundleUserPrependBlocks(blocks: SystemTextBlock[]): string | null {
  if (blocks.length === 0) return null;
  const body = blocks.map(bundleEntryText).join("\n");
  return BUNDLE_OPEN + BUNDLE_PREAMBLE + body + BUNDLE_IMPORTANT_LINE + BUNDLE_CLOSE;
}

function firstUserText(messages: Message[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const block = firstUser?.content.find((b) => b.type === "text");
  return block?.type === "text" ? block.text : "";
}

// Phase-split: static layers fold into one global-scope cache block; dynamic layers (env-info, scratchpad, bg-session, memory-guidance, injections) fold into a separate org-scope block. Empty buckets emit zero blocks, and order is preserved within each bucket.
function consolidateHarnessBlocks(blocks: SystemTextBlock[]): ContentBlock[] {
  if (blocks.length === 0) return [];
  const staticParts: string[] = [];
  const dynamicParts: string[] = [];
  for (const b of blocks) {
    if (b.phase === "dynamic") dynamicParts.push(b.text);
    else staticParts.push(b.text);
  }
  const out: ContentBlock[] = [];
  const staticJoined = staticParts.join("\n\n");
  if (staticJoined) {
    out.push({ type: "text", text: staticJoined, cache_control: CACHE_CONTROL_1H_GLOBAL });
  }
  const dynamicJoined = dynamicParts.join("\n\n");
  if (dynamicJoined) {
    out.push({ type: "text", text: dynamicJoined, cache_control: CACHE_CONTROL_1H });
  }
  return out;
}

export function composeAnthropicMessages(harness: ComposedHarness, messages: Message[]): Message[] {
  const out: Message[] = [];
  const preambleBlocks: ContentBlock[] = [
    {
      type: "text",
      text: systemBillingHeader(firstUserText(messages), lastAssistantRequestId(messages)),
    },
    { type: "text", text: SYSTEM_OPENER.trim() },
  ];
  const harnessBlocks = consolidateHarnessBlocks(harness.systemBlocks);
  out.push({ role: "system", content: [...preambleBlocks, ...harnessBlocks] });
  // Short-circuit on ORIGINAL userPrepend length so an all-stripped-to-empty
  // bundle still skips prepend logic correctly (per design risk: empty-bundle
  // short-circuit must track input, not output).
  let prependedFirstUser = harness.userPrepend.length === 0;
  const standaloneBlocks = harness.userPrepend.filter((b) => b.standalone);
  const bundledBlocks = harness.userPrepend.filter((b) => !b.standalone);
  const userPrependBundle = bundleUserPrependBlocks(bundledBlocks);
  // The promoted harness reminders travel as ONE system message after the
  // first user turn, every reminder joined into a single text block; the
  // composer already resolved the wrapper per model.
  const midJoined = (harness.midSystemBlocks ?? [])
    .map((b) => b.text)
    .filter((text) => text.length > 0)
    .join("\n\n");
  const midSystemMessage: Message | undefined =
    midJoined.length > 0
      ? { role: "system", content: [{ type: "text", text: midJoined }] }
      : undefined;
  let insertedMidSystemMessage = false;
  for (const msg of messages) {
    const stripped = stripUserCacheControl(msg);
    // The API only accepts a mid-conversation system message after a user or
    // an assistant ending in a server tool result. Inspect `out`, rather than
    // the source history, so earlier transformations determine the position.
    const promoted = promoteReminderMessage(msg, harness.midSystemPromotion, out[out.length - 1]);
    if (promoted) {
      out.push(promoted);
      continue;
    }
    if (!prependedFirstUser && msg.role === "user") {
      const prependBlocks: ContentBlock[] = [];
      for (const block of standaloneBlocks) {
        prependBlocks.push({
          type: "text",
          text:
            "<system-reminder>\n" + stripSystemReminderWrapper(block.text) + "\n</system-reminder>",
        });
      }
      if (userPrependBundle) {
        prependBlocks.push({
          type: "text",
          text: userPrependBundle,
        });
      }
      let insertAt = 0;
      while (
        insertAt < stripped.content.length &&
        stripped.content[insertAt]?.type === "tool_result"
      ) {
        insertAt++;
      }
      const head = stripped.content.slice(0, insertAt);
      const tail = stripped.content.slice(insertAt);
      out.push({ ...stripped, content: [...head, ...prependBlocks, ...tail] });
      prependedFirstUser = true;
    } else {
      out.push(stripped);
    }
    if (!insertedMidSystemMessage && midSystemMessage && msg.role === "user") {
      out.push(midSystemMessage);
      insertedMidSystemMessage = true;
    }
  }
  if (midSystemMessage && !insertedMidSystemMessage) out.push(midSystemMessage);
  // The trailing breakpoint lands on whatever conversation message is last —
  // on the opening request that is the promoted system message.
  applyTrailingConversationCacheControl(out, "1h");
  return out;
}

// A text-only user message carrying a harness reminder marker can become a
// mid-conversation system message in place. The unwrap set drops the reminder
// envelope, but promotion is valid only at an API-accepted final position.
function promoteReminderMessage(
  msg: Message,
  promotion: MidSystemPromotion,
  previous: Message | undefined,
): Message | null {
  if (
    promotion === "off" ||
    msg.role !== "user" ||
    msg.content.length === 0 ||
    !canPrecedeMidConversationSystem(previous)
  ) {
    return null;
  }
  const textBlocks: Extract<ContentBlock, { type: "text" }>[] = [];
  for (const block of msg.content) {
    if (block.type !== "text") return null;
    textBlocks.push(block);
  }
  if (!textBlocks.some((block) => block.reminder_type !== undefined)) return null;
  const text = textBlocks
    .map((block) =>
      promotion === "unwrapped" ? stripSystemReminderWrapper(block.text) : block.text,
    )
    .join("\n\n");
  return { role: "system", content: [{ type: "text", text }] };
}

function canPrecedeMidConversationSystem(message: Message | undefined): boolean {
  if (!message) return false;
  if (message.role === "user") return true;
  if (message.role !== "assistant") return false;
  const last = message.content[message.content.length - 1];
  return last !== undefined && SERVER_TOOL_RESULT_TYPES.has(last.type);
}

function dropCacheControl(b: ContentBlock): ContentBlock {
  if (b.type === "text") return { type: "text", text: b.text };
  if (b.type === "tool_result")
    return {
      type: "tool_result",
      tool_use_id: b.tool_use_id,
      content: b.content,
      ...(b.is_error !== undefined ? { is_error: b.is_error } : {}),
    };
  return b;
}

function stripUserCacheControl(msg: Message): Message {
  if (msg.role !== "user") return msg;
  return { ...msg, content: msg.content.map(dropCacheControl) };
}

function withCacheControl(block: ContentBlock, ttl: "1h" | "5m"): ContentBlock {
  const cc = { type: "ephemeral" as const, ttl };
  if (block.type === "text") return { ...block, cache_control: cc };
  if (block.type === "tool_result") return { ...block, cache_control: cc };
  return block;
}

// User and promoted system messages both carry the trailing breakpoint;
// assistant tails never do.
function applyTrailingConversationCacheControl(messages: Message[], ttl: "1h" | "5m" = "1h"): void {
  const last = messages[messages.length - 1];
  if (!last || (last.role !== "user" && last.role !== "system")) return;
  const idx = last.content.length - 1;
  const block = last.content[idx];
  if (!block) return;
  last.content[idx] = withCacheControl(block, ttl);
}

export function applyTrailingCacheControl(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  // User and promoted system tails both carry the breakpoint; assistant never.
  if (!last || (last.role !== "user" && last.role !== "system")) return messages;
  const idx = last.content.length - 1;
  const block = last.content[idx];
  if (!block) return messages;
  const out = [...messages];
  const lastContent = [...last.content];
  lastContent[idx] = withCacheControl(block, "1h");
  out[out.length - 1] = { ...last, content: lastContent };
  return out;
}
