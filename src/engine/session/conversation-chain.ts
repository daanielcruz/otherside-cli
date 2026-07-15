import { parseLineEnvelope } from "./transcript/truncate.ts";

// Single source of truth for reconstructing foreign-format session transcripts by walking `parentUuid` from the active leaf back to the root.
//
// This reconstruction runs only when the file has no `_os` sidecar, which identifies a foreign session or subagent transcript. Native otherside files use file-order reconstruction: they remain strictly linear on disk because revoke and rewind reparent in place, so file order is already the active chain and there are no abandoned branches to prune.
//
// The walk selects a leaf, traverses backward through `parentUuid` with cycle detection and a timestamp-based sibling fallback, then performs DAG recovery to reattach parallel tool_result siblings that the single-parent walk would drop.

const CHAIN_TIMESTAMP_FALLBACK_WINDOW_MS = 5000;

export interface ChainNode {
  uuid: string;
  parentUuid: string | null;
  isSidechain: boolean;
  type: string;
  subtype: string | null;
  timestamp: string;
  messageId: string | null;
  agentId: string | null;
  hasToolResult: boolean;
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

function hasToolResultBlock(obj: Record<string, unknown>): boolean {
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
      messageId: messageIdOf(obj),
      agentId: typeof obj.agentId === "string" ? obj.agentId : null,
      hasToolResult: type === "user" && hasToolResultBlock(obj),
      raw: obj,
    });
  }
  return foreign ? map : null;
}

// Latest node satisfying the predicate, by parsed timestamp; first-seen wins on a tie.
function findLatestNode(
  map: Map<string, ChainNode>,
  predicate: (node: ChainNode) => boolean,
): ChainNode | undefined {
  let latest: ChainNode | undefined;
  let maxTime = Number.NEGATIVE_INFINITY;
  for (const node of map.values()) {
    if (!predicate(node)) continue;
    const time = Date.parse(node.timestamp);
    if (Number.isNaN(time)) continue;
    if (time > maxTime) {
      maxTime = time;
      latest = node;
    }
  }
  return latest;
}

// Main session leaf: latest non-sidechain node of any type, not just user or assistant.
function selectMainLeaf(map: Map<string, ChainNode>): ChainNode | undefined {
  return findLatestNode(map, (node) => !node.isSidechain);
}

// Subagent leaf: latest sidechain node, optionally scoped to one agentId, that is not another sidechain node's parent — a true leaf with no children.
function selectSidechainLeaf(
  map: Map<string, ChainNode>,
  agentId: string | undefined,
): ChainNode | undefined {
  const scoped = (node: ChainNode): boolean =>
    node.isSidechain && (agentId === undefined || node.agentId === agentId);
  const referencedParents = new Set<string>();
  for (const node of map.values()) {
    if (!scoped(node)) continue;
    if (node.parentUuid !== null) referencedParents.add(node.parentUuid);
  }
  return findLatestNode(map, (node) => scoped(node) && !referencedParents.has(node.uuid));
}

// Heuristic parent when `parentUuid` does not resolve because it is missing or part of an already-walked cycle: use the closest preceding node with the same sidechain flag inside the fallback window.
function findChainTimestampNeighbor(
  map: Map<string, ChainNode>,
  child: ChainNode,
  seen: Set<string>,
): ChainNode | undefined {
  const childTime = Date.parse(child.timestamp);
  if (Number.isNaN(childTime)) return undefined;
  let best: ChainNode | undefined;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const candidate of map.values()) {
    if (seen.has(candidate.uuid)) continue;
    if (candidate.isSidechain !== child.isSidechain) continue;
    const candidateTime = Date.parse(candidate.timestamp);
    if (Number.isNaN(candidateTime)) continue;
    const delta = childTime - candidateTime;
    if (delta >= 0 && delta <= CHAIN_TIMESTAMP_FALLBACK_WINDOW_MS && delta < bestDelta) {
      bestDelta = delta;
      best = candidate;
    }
  }
  return best;
}

interface WalkResult {
  chain: ChainNode[];
  seen: Set<string>;
}

function walkFromLeaf(map: Map<string, ChainNode>, leaf: ChainNode): WalkResult {
  const chain: ChainNode[] = [];
  const seen = new Set<string>();
  let current: ChainNode | undefined = leaf;
  while (current) {
    if (seen.has(current.uuid)) break;
    seen.add(current.uuid);
    chain.push(current);
    if (!current.parentUuid) break;
    let parent = map.get(current.parentUuid);
    if (!parent || seen.has(parent.uuid)) {
      parent = findChainTimestampNeighbor(map, current, seen);
    }
    current = parent;
  }
  chain.reverse();
  return { chain, seen };
}

// Streaming emits one assistant message per content_block_stop, so parallel tool_uses become sibling assistant nodes sharing one `message.id`, and each tool_result's parentUuid points to its own sibling. The single-parent walk keeps one branch; this pass reattaches off-chain siblings and their tool results after the last on-chain member so each group stays contiguous.
function recoverOrphanedParallelToolResults(
  map: Map<string, ChainNode>,
  chain: ChainNode[],
  seen: Set<string>,
): ChainNode[] {
  const chainAssistants = chain.filter(
    (node) => node.type === "assistant" && node.messageId !== null,
  );
  if (chainAssistants.length === 0) return chain;

  // Last on-chain member of each sibling group wins (chain is already ordered).
  const anchorByMessageId = new Map<string, ChainNode>();
  for (const node of chainAssistants) {
    if (node.messageId !== null) anchorByMessageId.set(node.messageId, node);
  }

  const siblingsByMessageId = new Map<string, ChainNode[]>();
  const toolResultsByParent = new Map<string, ChainNode[]>();
  for (const node of map.values()) {
    if (node.type === "assistant" && node.messageId !== null) {
      const group = siblingsByMessageId.get(node.messageId);
      if (group) group.push(node);
      else siblingsByMessageId.set(node.messageId, [node]);
    } else if (node.type === "user" && node.hasToolResult && node.parentUuid !== null) {
      const group = toolResultsByParent.get(node.parentUuid);
      if (group) group.push(node);
      else toolResultsByParent.set(node.parentUuid, [node]);
    }
  }

  const processedGroups = new Set<string>();
  const inserts = new Map<string, ChainNode[]>();
  let recoveredCount = 0;
  for (const assistant of chainAssistants) {
    const messageId = assistant.messageId;
    if (messageId === null || processedGroups.has(messageId)) continue;
    processedGroups.add(messageId);

    const group = siblingsByMessageId.get(messageId) ?? [assistant];
    const orphanedSiblings = group.filter((sibling) => !seen.has(sibling.uuid));
    const orphanedToolResults: ChainNode[] = [];
    for (const member of group) {
      const results = toolResultsByParent.get(member.uuid);
      if (!results) continue;
      for (const result of results) {
        if (!seen.has(result.uuid)) orphanedToolResults.push(result);
      }
    }
    if (orphanedSiblings.length === 0 && orphanedToolResults.length === 0) continue;

    orphanedSiblings.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    orphanedToolResults.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const anchor = anchorByMessageId.get(messageId);
    if (!anchor) continue;
    const recovered = [...orphanedSiblings, ...orphanedToolResults];
    for (const node of recovered) seen.add(node.uuid);
    recoveredCount += recovered.length;
    inserts.set(anchor.uuid, recovered);
  }

  if (recoveredCount === 0) return chain;

  const result: ChainNode[] = [];
  for (const node of chain) {
    result.push(node);
    const toInsert = inserts.get(node.uuid);
    if (toInsert) result.push(...toInsert);
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

  const { chain, seen } = walkFromLeaf(map, leaf);
  const recovered = recoverOrphanedParallelToolResults(map, chain, seen);
  const scoped =
    options.sidechain && options.agentId !== undefined
      ? recovered.filter((node) => node.agentId === options.agentId)
      : recovered;
  return scoped.map((node) => node.raw);
}

// The active leaf uuid of a foreign main-session transcript, or null when the
// file is native otherside.
export function foreignMainChainHead(lines: string[]): string | null {
  const map = buildForeignChainGraph(lines);
  if (map === null) return null;
  return selectMainLeaf(map)?.uuid ?? null;
}
