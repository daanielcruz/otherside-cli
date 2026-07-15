import type { Message } from "@/kernel/std/types/message.ts";

export function groupByApiRound(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  let current: Message[] = [];
  let lastAssistantId: string | undefined;
  for (const msg of messages) {
    if (
      msg.role === "assistant" &&
      msg.id !== undefined &&
      msg.id !== lastAssistantId &&
      current.length > 0
    ) {
      groups.push(current);
      current = [msg];
    } else {
      current.push(msg);
    }
    if (msg.role === "assistant" && msg.id !== undefined) {
      lastAssistantId = msg.id;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

export function trimHeadGroupsByCount(
  messages: Message[],
  groupsToDrop: number,
): { messages: Message[]; droppedGroups: number; droppedMessages: number } {
  if (groupsToDrop <= 0) return { messages, droppedGroups: 0, droppedMessages: 0 };
  const groups = groupByApiRound(messages);
  if (groups.length <= 1) return { messages, droppedGroups: 0, droppedMessages: 0 };
  const dropCount = Math.min(groupsToDrop, groups.length - 1);
  const dropped = groups.splice(0, dropCount);
  const droppedMessages = dropped.reduce((acc, g) => acc + g.length, 0);
  return { messages: groups.flat(), droppedGroups: dropCount, droppedMessages };
}
