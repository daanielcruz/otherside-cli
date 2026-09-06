export interface InboxMessage {
  id: string;
  to: string;
  from?: string;
  message: string;
  replyTo?: string;
  enqueuedAt: number;
  delivered: boolean;
}

/**
 * How a delivered message reads to the agent receiving it. An agent that cannot tell
 * who wrote to it cannot answer them, so the sender leads whenever one is known.
 */
export function addressedMessageText(message: {
  message: string;
  from?: string | undefined;
  replyTo?: string | undefined;
}): string {
  const marks: string[] = [];
  if (message.from !== undefined) marks.push(`From ${message.from}`);
  if (message.replyTo !== undefined) marks.push(`Reply to ${message.replyTo}`);
  return marks.length === 0 ? message.message : `[${marks.join(" · ")}]\n${message.message}`;
}

export type InboxFailureCode = "unknown_recipient" | "inbox_unavailable";

export type InboxDeliveryResult =
  | { delivered: true; messageId: string; agentId: string }
  | { delivered: false; code: InboxFailureCode; reason: string };

type DeliveryHandler = (message: InboxMessage) => void;

// Addressing is id-only. "main" is the one reserved address — the standing
// channel to the main conversation, not an agent name.
const MAIN_ADDRESS = "main";
const queues = new Map<string, InboxMessage[]>();
const deliveryHandlers = new Map<string, DeliveryHandler>();
let mainAgentId: string | null = null;
let counter = 0;

function nextId(): string {
  counter++;
  return `msg_${Date.now()}_${counter.toString(36)}`;
}

export function registerMainAgent(agentId: string): () => void {
  if (!queues.has(agentId)) queues.set(agentId, []);
  mainAgentId = agentId;
  return () => unregisterAgent(agentId);
}

export function registerAgent(agentId: string, onMessage?: DeliveryHandler): () => void {
  if (!queues.has(agentId)) queues.set(agentId, []);
  if (onMessage) deliveryHandlers.set(agentId, onMessage);
  return () => unregisterAgent(agentId);
}

export function unregisterAgent(agentId: string): void {
  queues.delete(agentId);
  deliveryHandlers.delete(agentId);
  if (mainAgentId === agentId) mainAgentId = null;
}

export function resolveAgentId(id: string): string | null {
  if (id === MAIN_ADDRESS && mainAgentId !== null) return mainAgentId;
  return queues.has(id) ? id : null;
}

export function enqueue(
  to: string,
  message: string,
  replyTo?: string,
  from?: string,
): InboxDeliveryResult {
  const agentId = resolveAgentId(to);
  if (agentId === null) {
    return {
      delivered: false,
      code: "unknown_recipient",
      reason: `agent "${to}" is not registered`,
    };
  }
  const queue = queues.get(agentId);
  if (!queue) {
    return {
      delivered: false,
      code: "inbox_unavailable",
      reason: `agent "${agentId}" has no inbox`,
    };
  }
  const msg: InboxMessage = {
    id: nextId(),
    to: agentId,
    ...(from !== undefined ? { from } : {}),
    message,
    ...(replyTo !== undefined ? { replyTo } : {}),
    enqueuedAt: Date.now(),
    delivered: false,
  };
  const handler = deliveryHandlers.get(agentId);
  if (handler) {
    try {
      handler(msg);
      msg.delivered = true;
      return { delivered: true, messageId: msg.id, agentId };
    } catch (error) {
      return {
        delivered: false,
        code: "inbox_unavailable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  queue.push(msg);
  return { delivered: true, messageId: msg.id, agentId };
}

export function dequeue(agentId: string): InboxMessage | null {
  const queue = queues.get(agentId);
  if (!queue || queue.length === 0) return null;
  const msg = queue.shift();
  if (!msg) return null;
  msg.delivered = true;
  return msg;
}

export function peek(agentId: string): InboxMessage[] {
  return [...(queues.get(agentId) ?? [])];
}

export function listAgents(): { agentId: string; pending: number }[] {
  return [...queues.entries()].map(([agentId, queue]) => ({
    agentId,
    pending: queue.length,
  }));
}

export function clear(): void {
  queues.clear();
  deliveryHandlers.clear();
  mainAgentId = null;
  counter = 0;
}
