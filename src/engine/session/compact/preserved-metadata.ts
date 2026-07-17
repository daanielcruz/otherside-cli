import {
  isChainParticipant,
  type PreservedMessages,
  type PreservedSegment,
  type SessionRecord,
} from "@/engine/session/record/index.ts";
import { sessionRecordsToMessages } from "@/engine/session/transcript/to-messages.ts";
import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";

export interface CompactPreserveMetadata {
  preservedSegment: PreservedSegment;
  preservedMessages: PreservedMessages;
}

export function preserveMetadataForTail(
  records: readonly SessionRecord[],
  preservedTail: readonly Message[],
  anchorUuid: string,
): CompactPreserveMetadata | null {
  if (preservedTail.length === 0) return null;
  const afterBoundary = records.findLastIndex((record) => record.type === "compaction_mark") + 1;
  const target = messageFingerprint(preservedTail);
  for (let start = records.length - 1; start >= afterBoundary; start -= 1) {
    const candidate = sessionRecordsToMessages(records.slice(start));
    if (messageFingerprint(candidate) !== target) continue;
    const uuids: string[] = [];
    for (const record of records.slice(start)) {
      if (!isChainParticipant(record.type)) continue;
      const uuid = "uuid" in record && typeof record.uuid === "string" ? record.uuid : null;
      if (uuid === null) return null;
      if (uuids.at(-1) !== uuid) uuids.push(uuid);
    }
    if (uuids.length === 0) return null;
    return {
      preservedSegment: {
        headUuid: uuids[0]!,
        tailUuid: uuids.at(-1)!,
        anchorUuid,
      },
      preservedMessages: { uuids, anchorUuid },
    };
  }
  return null;
}

function messageFingerprint(messages: readonly Message[]): string {
  return JSON.stringify(
    messages.map((message) => ({
      role: message.role,
      content: message.content.map(blockFingerprint),
    })),
  );
}

function blockFingerprint(block: ContentBlock): unknown {
  switch (block.type) {
    case "text":
      return { type: block.type, text: block.text };
    case "thinking":
      return { type: block.type, text: block.text, signature: block.signature ?? null };
    case "tool_use":
      return { type: block.type, id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: block.type,
        tool_use_id: block.tool_use_id,
        content: block.content,
        is_error: block.is_error === true,
      };
    case "image":
      return { type: block.type, source: block.source };
  }
}
