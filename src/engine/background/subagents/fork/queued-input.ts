import { nowIso } from "@/engine/session/record/index.ts";
import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import type { ForkSpec, SidechainRecord } from "./types.ts";

export function injectQueuedUserInput(args: {
  spec: ForkSpec;
  fork: Message[];
  ctx: RequestContext;
  appendSidechainRecord: (record: SidechainRecord) => void;
}): boolean {
  if (!args.spec.pendingUserInputDrainer) return false;
  const queuedMessages = args.spec.pendingUserInputDrainer();
  if (queuedMessages.length === 0) return false;
  const queuedBlocks: ContentBlock[] = [
    {
      type: "text",
      text: "<system-reminder>\nAdditional user messages arrived while you were working. Address them, but do not abandon the original task unless a new message clearly redirects or cancels it. After handling any side question, continue the original work.\n</system-reminder>",
      reminder_type: "queued_input",
    },
  ];
  for (const msg of queuedMessages) {
    for (const block of msg.blocks) queuedBlocks.push(block);
  }
  args.fork.push({ role: "user", content: queuedBlocks });
  for (const msg of queuedMessages) {
    const inlineImages = msg.blocks.filter((block) => block.type === "image");
    args.appendSidechainRecord({
      type: "user_message",
      ts: nowIso(),
      content: msg.text,
      provider: args.ctx.provider,
      model: args.ctx.model,
      ...(msg.queueId !== undefined ? { queueId: msg.queueId } : {}),
      ...(inlineImages.length > 0 ? { inlineImages } : {}),
    });
  }
  return true;
}
