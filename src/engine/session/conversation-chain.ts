import { parseLineEnvelope } from "./transcript/truncate.ts";

// Single source of truth for reconstructing foreign-format session transcripts by walking `parentUuid` from the active leaf back to the root.
//
// This reconstruction runs only when the file has no `_os` sidecar, which identifies a foreign session or subagent transcript. Native otherside files use file-order reconstruction: they remain strictly linear on disk because revoke and rewind reparent in place, so file order is already the active chain and there are no abandoned branches to prune.
//
// The walk selects a leaf, traverses backward through `parentUuid` with cycle detection and a timestamp-based sibling fallback, then performs DAG recovery to reattach parallel tool_result siblings that the single-parent walk would drop.

const FALLBACK_PARENT_WINDOW_MS = 5000;

export interface ChainNode {
  uuid: string;
  parentUuid: string | null;
  isSidechain: boolean;
  type: string;
  subtype: string | null;
  timestamp: string;
  at: number;
  messageId: string | null;
  agentId: string | null;
  withToolResult: boolean;
  raw: Record<string, unknown>;
}

export interface ReconstructOptions {
  sidechain: boolean;
  agentId?: string;
}

function messageIdOf(obj: Record<string, unknown>): string | null {
  const message = obj.message;
  if (!message || typeof message !== "object") return null;
  const id = (message as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

function messageCarriesToolResult(obj: Record<string, unknown>): boolean {
  const message = obj.message;
  if (!message || typeof message !== "object") return false;
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      !!block &&
      typeof block === "object" &&
      (block as Record<string, unknown>).type === "tool_result",
  );
}

// Parse lines into a uuid→node graph. Returns null when the file is not a foreign transcript: an `_os` sidecar identifies a native otherside file, and files with no conversation line are not transcripts. A null result tells the caller to use native file-order reconstruction.
export function buildForeignChainGraph(lines: string[]): Map<string, ChainNode> | null {
  const map = new Map<string, ChainNode>();
  let foreign = false;
  for (const line of lines) {
    const obj = parseLineEnvelope(line);
    if (!obj) continue;
    if ("_os" in obj) return null;
    const type = typeof obj.type === "string" ? obj.type : null;
    if (!type) continue;
    if (type === "user" || type === "assistant" || type === "summary" || type === "attachment") {
      foreign = true;
    }
    if (!foreign) continue;
    const uuid = typeof obj.uuid === "string" ? obj.uuid : null;
    const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : null;
    if (!uuid || !timestamp) continue;
    map.set(uuid, {
      uuid,
      parentUuid: typeof obj.parentUuid === "string" ? obj.parentUuid : null,
      isSidechain: obj.isSidechain === true,
      type,
      subtype: typeof obj.subtype === "string" ? obj.subtype : null,
      timestamp,
      at: Date.parse(timestamp),
      messageId: messageIdOf(obj),
      agentId: typeof obj.agentId === "string" ? obj.agentId : null,
      withToolResult: type === "user" && messageCarriesToolResult(obj),
      raw: obj,
    });
  }
  return foreign ? map : null;
}

function* where<T>(items: Iterable<T>, keep: (item: T) => boolean): Iterable<T> {
  for (const item of items) {
    if (keep(item)) yield item;
  }
}

// Most recent node by parsed time; earliest iteration order wins a tie, and nodes with unparseable time never win.
function mostRecent(nodes: Iterable<ChainNode>): ChainNode | undefined {
  let winner: ChainNode | undefined;
  for (const node of nodes) {
    if (Number.isNaN(node.at)) continue;
    if (winner === undefined || node.at > winner.at) winner = node;
  }
  return winner;
}

// Main session leaf: latest non-sidechain node of any type, not just user or assistant.
function selectMainLeaf(map: Map<string, ChainNode>): ChainNode | undefined {
  return mostRecent(where(map.values(), (node) => !node.isSidechain));
}

// Subagent leaf: latest sidechain node, optionally scoped to one agentId, that is not another sidechain node's parent — a true leaf with no children.
function selectSidechainLeaf(
  map: Map<string, ChainNode>,
  agentId: string | undefined,
): ChainNode | undefined {
  const inScope = (node: ChainNode): boolean =>
    node.isSidechain && (agentId === undefined || node.agentId === agentId);
  const referencedParents = new Set<string>();
  for (const node of map.values()) {
    if (!inScope(node)) continue;
    if (node.parentUuid !== null) referencedParents.add(node.parentUuid);
  }
  return mostRecent(
    where(map.values(), (node) => inScope(node) && !referencedParents.has(node.uuid)),
  );
}

// Substitute parent when the recorded `parentUuid` does not resolve because it is missing or part of an already-walked cycle: the most recent un-walked node on the same branch inside the fallback window.
function adoptFallbackParent(
  map: Map<string, ChainNode>,
  node: ChainNode,
  walked: Set<string>,
): ChainNode | undefined {
  if (Number.isNaN(node.at)) return undefined;
  return mostRecent(
    where(map.values(), (candidate) => {
      if (walked.has(candidate.uuid)) return false;
      if (candidate.isSidechain !== node.isSidechain) return false;
      if (Number.isNaN(candidate.at)) return false;
      const gap = node.at - candidate.at;
      return gap >= 0 && gap <= FALLBACK_PARENT_WINDOW_MS;
    }),
  );
}

interface WalkResult {
  chain: ChainNode[];
  walked: Set<string>;
}

function walkFromLeaf(map: Map<string, ChainNode>, leaf: ChainNode): WalkResult {
  const chain: ChainNode[] = [];
  const walked = new Set<string>();
  let current: ChainNode | undefined = leaf;
  while (current) {
    if (walked.has(current.uuid)) break;
    walked.add(current.uuid);
    chain.push(current);
    if (!current.parentUuid) break;
    let parent = map.get(current.parentUuid);
    if (!parent || walked.has(parent.uuid)) {
      parent = adoptFallbackParent(map, current, walked);
    }
    current = parent;
  }
  chain.reverse();
  return { chain, walked };
}

// Streaming emits one assistant message per content_block_stop, so parallel tool_uses become sibling assistant nodes sharing one `message.id`, and each tool_result's parentUuid points to its own sibling. The single-parent walk keeps one branch; this pass reattaches off-walk siblings and their tool results after the last walked member so each group stays contiguous.
function recoverOrphanedParallelResults(
  map: Map<string, ChainNode>,
  chain: ChainNode[],
  walked: Set<string>,
): ChainNode[] {
  const walkedAssistants = chain.filter(
    (node) => node.type === "assistant" && node.messageId !== null,
  );
  if (walkedAssistants.length === 0) return chain;

  // Last walked member of each sibling group wins (chain is already ordered).
  const lastWalkedByMessage = new Map<string, ChainNode>();
  for (const node of walkedAssistants) {
    if (node.messageId !== null) lastWalkedByMessage.set(node.messageId, node);
  }

  const assistantsByMessage = new Map<string, ChainNode[]>();
  const resultsByParent = new Map<string, ChainNode[]>();
  for (const node of map.values()) {
    if (node.type === "assistant" && node.messageId !== null) {
      const group = assistantsByMessage.get(node.messageId);
      if (group) group.push(node);
      else assistantsByMessage.set(node.messageId, [node]);
    } else if (node.type === "user" && node.withToolResult && node.parentUuid !== null) {
      const group = resultsByParent.get(node.parentUuid);
      if (group) group.push(node);
      else resultsByParent.set(node.parentUuid, [node]);
    }
  }

  const handledMessages = new Set<string>();
  const reattachments = new Map<string, ChainNode[]>();
  let reattachedCount = 0;
  for (const assistant of walkedAssistants) {
    const messageId = assistant.messageId;
    if (messageId === null || handledMessages.has(messageId)) continue;
    handledMessages.add(messageId);

    const group = assistantsByMessage.get(messageId) ?? [assistant];
    const unwalkedSiblings = group.filter((sibling) => !walked.has(sibling.uuid));
    const unwalkedResults: ChainNode[] = [];
    for (const member of group) {
      const results = resultsByParent.get(member.uuid);
      if (!results) continue;
      for (const result of results) {
        if (!walked.has(result.uuid)) unwalkedResults.push(result);
      }
    }
    if (unwalkedSiblings.length === 0 && unwalkedResults.length === 0) continue;

    unwalkedSiblings.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    unwalkedResults.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const anchor = lastWalkedByMessage.get(messageId);
    if (!anchor) continue;
    const reattached = [...unwalkedSiblings, ...unwalkedResults];
    for (const node of reattached) walked.add(node.uuid);
    reattachedCount += reattached.length;
    reattachments.set(anchor.uuid, reattached);
  }

  if (reattachedCount === 0) return chain;

  const result: ChainNode[] = [];
  for (const node of chain) {
    result.push(node);
    const pending = reattachments.get(node.uuid);
    if (pending) result.push(...pending);
  }
  return result;
}

// Reconstruct a foreign transcript as ordered raw line objects, or return null for a native otherside file so the caller falls back to file order. For subagents, pass `sidechain: true` and optionally an `agentId` scope.
export function reconstructForeignConversation(
  lines: string[],
  options: ReconstructOptions,
): Record<string, unknown>[] | null {
  const map = buildForeignChainGraph(lines);
  if (map === null) return null;

  const leaf = options.sidechain ? selectSidechainLeaf(map, options.agentId) : selectMainLeaf(map);
  if (!leaf) return [];

  const { chain, walked } = walkFromLeaf(map, leaf);
  const reattached = recoverOrphanedParallelResults(map, chain, walked);
  const scoped =
    options.sidechain && options.agentId !== undefined
      ? reattached.filter((node) => node.agentId === options.agentId)
      : reattached;
  return scoped.map((node) => node.raw);
}

// The active leaf uuid of a foreign main-session transcript, or null when the
// file is native otherside.
export function foreignMainChainHead(lines: string[]): string | null {
  const map = buildForeignChainGraph(lines);
  if (map === null) return null;
  return selectMainLeaf(map)?.uuid ?? null;
}
