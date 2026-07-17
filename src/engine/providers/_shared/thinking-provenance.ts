import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";

export type ThinkingBlock = Extract<ContentBlock, { type: "thinking" }>;

export interface ThinkingProvenance {
  producedBy?: Message["producedBy"] | undefined;
  producedModel?: string | undefined;
  producedAccount?: string | undefined;
}

/**
 * Resolve the provenance a replay gate must judge a thinking block by.
 *
 * The block stamp is authoritative: history rebuilds can merge assistant
 * messages from different producers into one message, so a message-level
 * stamp may describe a sibling block. The message stamp is only a fallback
 * for legacy blocks persisted before per-block stamping.
 */
export function thinkingProvenance(
  block: ThinkingBlock,
  fallback: ThinkingProvenance,
): ThinkingProvenance {
  return {
    producedBy: block.producedBy ?? fallback.producedBy,
    producedModel: block.producedModel ?? fallback.producedModel,
    producedAccount: block.producedAccount ?? fallback.producedAccount,
  };
}
