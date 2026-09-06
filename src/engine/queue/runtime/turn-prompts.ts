import type { DrainedQueuedMessage } from "@/kernel/std/types/events.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";

export function currentLocalISODate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const QUEUED_INPUT_REMINDER =
  "<system-reminder>\nAdditional user messages arrived while you were working. Address them, but do not abandon the original task unless a new message clearly redirects or cancels it. After handling any side question, continue the original work.\n</system-reminder>";

export function queuedInputBlocks(messages: readonly DrainedQueuedMessage[]): ContentBlock[] {
  const blocks: ContentBlock[] = [
    { type: "text", text: QUEUED_INPUT_REMINDER, reminder_type: "queued_input" },
  ];
  for (const msg of messages) {
    for (const block of msg.blocks) blocks.push(block);
  }
  return blocks;
}
