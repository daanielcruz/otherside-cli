import type { ModelEntry } from "@/engine/model/catalog.ts";
import type { ContentBlock, Message, ToolResultContentBlock } from "@/kernel/std/types/message.ts";

// Server-side media limits (Anthropic API facts, verified 2025-12): at most
// 100 media items per request (600 when the model has a 1M context window)
// and ~75MB of media bytes total. Over-strip by a slack margin so the
// counters don't ping-pong across the threshold on every request.
export const MAX_MEDIA_ITEMS_PER_REQUEST = 100;
export const MAX_MEDIA_ITEMS_PER_REQUEST_1M = 600;
export const MEDIA_ITEM_STRIP_SLACK = 20;
export const MEDIA_BYTE_CAP = 78_643_200;
export const MEDIA_BYTE_STRIP_SLACK = 10_485_760;
export const MEDIA_REMOVED_PLACEHOLDER = "[media removed: request limit]";

const ONE_MILLION_CONTEXT = 1_000_000;

export function mediaItemLimitFor(modelId: string, models: readonly ModelEntry[]): number {
  const entry = models.find((m) => m.id === modelId);
  return entry !== undefined && entry.contextWindow >= ONE_MILLION_CONTEXT
    ? MAX_MEDIA_ITEMS_PER_REQUEST_1M
    : MAX_MEDIA_ITEMS_PER_REQUEST;
}

type ImageBlock = Extract<ContentBlock, { type: "image" }>;
type NestedImageBlock = Extract<ToolResultContentBlock, { type: "image" }>;

function imageByteLength(block: ImageBlock | NestedImageBlock): number {
  return block.source.type === "base64" ? block.source.data.length : 0;
}

// Ensures messages carry at most `itemLimit` media items and MEDIA_BYTE_CAP
// media bytes, dropping the OLDEST media first so the most recent survives.
// Media nested inside tool results counts and is stripped the same way.
export function stripExcessMedia(messages: Message[], itemLimit: number): Message[] {
  let mediaCount = 0;
  let mediaBytes = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "image") {
        mediaCount++;
        mediaBytes += imageByteLength(block);
      } else if (block.type === "tool_result" && Array.isArray(block.content)) {
        for (const nested of block.content) {
          if (nested.type === "image") {
            mediaCount++;
            mediaBytes += imageByteLength(nested);
          }
        }
      }
    }
  }

  let itemsToRemove = mediaCount - itemLimit;
  let bytesToRemove = mediaBytes - MEDIA_BYTE_CAP;
  if (itemsToRemove <= 0 && bytesToRemove <= 0) return messages;
  if (itemsToRemove > 0) itemsToRemove += MEDIA_ITEM_STRIP_SLACK;
  if (bytesToRemove > 0) bytesToRemove += MEDIA_BYTE_STRIP_SLACK;

  const shouldRemove = (byteLength: number): boolean => {
    if (itemsToRemove > 0 || (bytesToRemove > 0 && byteLength > 0)) {
      itemsToRemove--;
      bytesToRemove -= byteLength;
      return true;
    }
    return false;
  };

  return messages.map((msg) => {
    if (itemsToRemove <= 0 && bytesToRemove <= 0) return msg;

    // Two passes per message, nested media first: within one message the
    // tool_result attachments are older context than the top-level blocks,
    // so they burn the removal budget before any top-level image does.
    let changed = false;
    const nestedStripped: ContentBlock[] = msg.content.map((block) => {
      if (
        block.type !== "tool_result" ||
        !Array.isArray(block.content) ||
        (itemsToRemove <= 0 && bytesToRemove <= 0)
      ) {
        return block;
      }
      const filtered = block.content.filter(
        (nested) => !(nested.type === "image" && shouldRemove(imageByteLength(nested))),
      );
      if (filtered.length === block.content.length) return block;
      changed = true;
      return { ...block, content: filtered };
    });
    const stripped = nestedStripped.filter((block) => {
      if (block.type !== "image") return true;
      if (!shouldRemove(imageByteLength(block))) return true;
      changed = true;
      return false;
    });
    if (!changed) return msg;

    const content: ContentBlock[] =
      stripped.length > 0 ? stripped : [{ type: "text", text: MEDIA_REMOVED_PLACEHOLDER }];
    return { ...msg, content };
  });
}
