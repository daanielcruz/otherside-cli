export interface InboxMessage {
  id: string;
  to: string;
  from?: string;
  message: string;
  replyTo?: string;
  enqueuedAt: number;
  delivered: boolean;
}

export type InboxFailureCode = "unknown_recipient" | "inbox_unavailable" | "ambiguous_recipient";

export type InboxDeliveryResult =
  | { delivered: true; messageId: string; agentId: string }
  | { delivered: false; code: InboxFailureCode; reason: string };

type DeliveryHandler = (message: InboxMessage) => void;

const MAIN_ALIAS = "main";
const queues = new Map<string, InboxMessage[]>();
const aliases = new Map<string, Set<string>>();
const deliveryHandlers = new Map<string, DeliveryHandler>();
let counter = 0;

function nextId(): string {
  counter++;
  return `msg_${Date.now()}_${counter.toString(36)}`;
}

function registerAlias(alias: string, agentId: string): void {
  let claimants = aliases.get(alias);
  if (!claimants) {
    claimants = new Set<string>();
    aliases.set(alias, claimants);
  }
  claimants.add(agentId);
}

export function registerMainAgent(agentId: string): () => void {
  if (!queues.has(agentId)) queues.set(agentId, []);
  aliases.set(MAIN_ALIAS, new Set([agentId]));
  return () => unregisterAgent(agentId);
}

export function registerAgent(
  agentId: string,
  name?: string,
  onMessage?: DeliveryHandler,
): () => void {
  if (name === MAIN_ALIAS) {
    throw new Error('agent name "main" is reserved for the main conversation');
  }
  if (!queues.has(agentId)) queues.set(agentId, []);
  if (name && name !== agentId) registerAlias(name, agentId);
  if (onMessage) deliveryHandlers.set(agentId, onMessage);
  return () => unregisterAgent(agentId);
}

export function unregisterAgent(agentId: string): void {
  queues.delete(agentId);
  deliveryHandlers.delete(agentId);
  for (const [alias, claimants] of aliases) {
    claimants.delete(agentId);
    if (claimants.size === 0) {
      aliases.delete(alias);
    }
  }
}

export function resolveAgentId(idOrName: string): string | null {
  if (queues.has(idOrName)) return idOrName;
  const claimants = aliases.get(idOrName);
  if (claimants && claimants.size === 1) {
    return Array.from(claimants)[0] ?? null;
  }
  return null;
}

export function agentDisplayName(agentId: string): string | null {
  const matchingAliases: string[] = [];
  for (const [alias, claimants] of aliases) {
    if (claimants.has(agentId) && claimants.size === 1) {
      matchingAliases.push(alias);
    }
  }
  if (matchingAliases.length === 1) {
    return matchingAliases[0] ?? null;
  }
  return null;
}

export function enqueue(
  to: string,
  message: string,
  replyTo?: string,
  from?: string,
): InboxDeliveryResult {
  let agentId: string | null = null;
  if (queues.has(to)) {
    agentId = to;
  } else {
    const claimants = aliases.get(to);
    if (claimants) {
      if (claimants.size > 1) {
        const sortedIds = Array.from(claimants).sort();
        return {
          delivered: false,
          code: "ambiguous_recipient",
          reason: `name "${to}" is claimed by ${claimants.size} running agents: ${sortedIds.join(", ")} — address one by its id`,
        };
      } else if (claimants.size === 1) {
        agentId = Array.from(claimants)[0] ?? null;
      }
    }
  }

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
  aliases.clear();
  deliveryHandlers.clear();
  counter = 0;
}
