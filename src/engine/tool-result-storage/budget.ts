import type { Message, ToolResultContentBlock } from "@/kernel/std/types/message.ts";
import { MAX_TOOL_RESULTS_PER_MESSAGE_CHARS } from "./constants.ts";
import {
  buildLargeToolResultMessage,
  contentSize,
  hasImageBlock,
  isPersistError,
  isPersistedOutputWrapper,
  persistToolResult,
} from "./persist.ts";

export type ContentReplacementState = {
  seenIds: Set<string>;
  replacements: Map<string, string>;
};

export function createContentReplacementState(): ContentReplacementState {
  return { seenIds: new Set(), replacements: new Map() };
}

export function cloneContentReplacementState(
  source: ContentReplacementState,
): ContentReplacementState {
  return {
    seenIds: new Set(source.seenIds),
    replacements: new Map(source.replacements),
  };
}

export function getPerMessageBudgetLimit(): number {
  return MAX_TOOL_RESULTS_PER_MESSAGE_CHARS;
}

export type ContentReplacementRecord = {
  kind: "tool-result";
  toolUseId: string;
  replacement: string;
};

export type ToolResultReplacementRecord = Extract<
  ContentReplacementRecord,
  { kind: "tool-result" }
>;

interface ToolResultCandidate {
  toolUseId: string;
  content: string | ToolResultContentBlock[];
  size: number;
}

interface CandidatePartition {
  mustReapply: Array<ToolResultCandidate & { replacement: string }>;
  frozen: ToolResultCandidate[];
  fresh: ToolResultCandidate[];
}

function collectCandidatesFromMessage(message: Message): ToolResultCandidate[] {
  if (message.role !== "user" || !Array.isArray(message.content)) {
    return [];
  }
  return message.content.flatMap((block) => {
    if (block.type !== "tool_result" || !block.content) return [];
    if (isPersistedOutputWrapper(block.content)) return [];
    if (hasImageBlock(block.content)) return [];
    return [
      {
        toolUseId: block.tool_use_id,
        content: block.content,
        size: contentSize(block.content),
      },
    ];
  });
}

function collectCandidatesByMessage(messages: Message[]): ToolResultCandidate[][] {
  const groups: ToolResultCandidate[][] = [];
  let current: ToolResultCandidate[] = [];
  const flush = () => {
    if (current.length > 0) groups.push(current);
    current = [];
  };
  const seenAsstIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "user") {
      current.push(...collectCandidatesFromMessage(message));
    } else if (message.role === "assistant") {
      const id = message.id ?? "";
      if (id === "" || !seenAsstIds.has(id)) {
        flush();
        if (id !== "") seenAsstIds.add(id);
      }
    }
  }
  flush();
  return groups;
}

function buildToolNameMap(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "tool_use") {
        map.set(block.id, block.name);
      }
    }
  }
  return map;
}

function partitionByPriorDecision(
  candidates: ToolResultCandidate[],
  state: ContentReplacementState,
): CandidatePartition {
  return candidates.reduce<CandidatePartition>(
    (acc, c) => {
      const replacement = state.replacements.get(c.toolUseId);
      if (replacement !== undefined) {
        acc.mustReapply.push({ ...c, replacement });
      } else if (state.seenIds.has(c.toolUseId)) {
        acc.frozen.push(c);
      } else {
        acc.fresh.push(c);
      }
      return acc;
    },
    { mustReapply: [], frozen: [], fresh: [] },
  );
}

function selectFreshToReplace(
  fresh: ToolResultCandidate[],
  frozenSize: number,
  limit: number,
): ToolResultCandidate[] {
  const sorted = [...fresh].sort((a, b) => b.size - a.size);
  const selected: ToolResultCandidate[] = [];
  let remaining = frozenSize + fresh.reduce((sum, c) => sum + c.size, 0);
  for (const c of sorted) {
    if (remaining <= limit) break;
    selected.push(c);
    remaining -= c.size;
  }
  return selected;
}

function replaceToolResultContents(
  messages: Message[],
  replacementMap: Map<string, string>,
): Message[] {
  return messages.map((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) {
      return message;
    }
    const content = message.content;
    const needsReplace = content.some(
      (b) => b.type === "tool_result" && replacementMap.has(b.tool_use_id),
    );
    if (!needsReplace) return message;
    return {
      ...message,
      content: content.map((block) => {
        if (block.type !== "tool_result") return block;
        const replacement = replacementMap.get(block.tool_use_id);
        return replacement === undefined ? block : { ...block, content: replacement };
      }),
    };
  });
}

async function buildReplacement(
  candidate: ToolResultCandidate,
): Promise<{ content: string; originalSize: number } | null> {
  const result = await persistToolResult(candidate.content, candidate.toolUseId);
  if (isPersistError(result)) return null;
  return {
    content: buildLargeToolResultMessage(result),
    originalSize: result.originalSize,
  };
}

export async function enforceToolResultBudget(
  messages: Message[],
  state: ContentReplacementState,
  skipToolNames: ReadonlySet<string> = new Set(["Read"]),
): Promise<{
  messages: Message[];
  newlyReplaced: ToolResultReplacementRecord[];
}> {
  const candidatesByMessage = collectCandidatesByMessage(messages);
  const nameByToolUseId = buildToolNameMap(messages);
  const shouldSkip = (id: string): boolean => skipToolNames.has(nameByToolUseId.get(id) ?? "");
  const limit = getPerMessageBudgetLimit();

  const replacementMap = new Map<string, string>();
  const toPersist: ToolResultCandidate[] = [];
  let reappliedCount = 0;
  let messagesOverBudget = 0;

  for (const candidates of candidatesByMessage) {
    const { mustReapply, frozen, fresh } = partitionByPriorDecision(candidates, state);

    mustReapply.forEach((c) => {
      replacementMap.set(c.toolUseId, c.replacement);
    });
    reappliedCount += mustReapply.length;

    if (fresh.length === 0) {
      candidates.forEach((c) => {
        state.seenIds.add(c.toolUseId);
      });
      continue;
    }

    const skipped = fresh.filter((c) => shouldSkip(c.toolUseId));
    skipped.forEach((c) => {
      state.seenIds.add(c.toolUseId);
    });
    const eligible = fresh.filter((c) => !shouldSkip(c.toolUseId));

    const frozenSize = frozen.reduce((sum, c) => sum + c.size, 0);
    const freshSize = eligible.reduce((sum, c) => sum + c.size, 0);

    const selected =
      frozenSize + freshSize > limit ? selectFreshToReplace(eligible, frozenSize, limit) : [];

    const selectedIds = new Set(selected.map((c) => c.toolUseId));
    candidates
      .filter((c) => !selectedIds.has(c.toolUseId))
      .forEach((c) => {
        state.seenIds.add(c.toolUseId);
      });

    if (selected.length === 0) continue;
    messagesOverBudget++;
    toPersist.push(...selected);
  }

  if (replacementMap.size === 0 && toPersist.length === 0) {
    return { messages, newlyReplaced: [] };
  }

  const freshReplacements = await Promise.all(
    toPersist.map(async (c) => [c, await buildReplacement(c)] as const),
  );
  const newlyReplaced: ToolResultReplacementRecord[] = [];
  for (const [candidate, replacement] of freshReplacements) {
    state.seenIds.add(candidate.toolUseId);
    if (replacement === null) continue;
    replacementMap.set(candidate.toolUseId, replacement.content);
    state.replacements.set(candidate.toolUseId, replacement.content);
    newlyReplaced.push({
      kind: "tool-result",
      toolUseId: candidate.toolUseId,
      replacement: replacement.content,
    });
  }

  if (replacementMap.size === 0) {
    return { messages, newlyReplaced: [] };
  }

  return {
    messages: replaceToolResultContents(messages, replacementMap),
    newlyReplaced,
  };
}

export async function applyToolResultBudget(
  messages: Message[],
  state: ContentReplacementState | undefined,
  writeToTranscript?: (records: ToolResultReplacementRecord[]) => void,
  skipToolNames?: ReadonlySet<string>,
): Promise<Message[]> {
  if (!state) return messages;
  const result = await enforceToolResultBudget(messages, state, skipToolNames);
  if (result.newlyReplaced.length > 0) {
    writeToTranscript?.(result.newlyReplaced);
  }
  return result.messages;
}

export function reconstructContentReplacementState(
  messages: Message[],
  records: ContentReplacementRecord[],
  inheritedReplacements?: ReadonlyMap<string, string>,
): ContentReplacementState {
  const state = createContentReplacementState();
  const candidateIds = new Set(
    collectCandidatesByMessage(messages)
      .flat()
      .map((c) => c.toolUseId),
  );

  for (const id of candidateIds) {
    state.seenIds.add(id);
  }
  for (const r of records) {
    if (r.kind === "tool-result" && candidateIds.has(r.toolUseId)) {
      state.replacements.set(r.toolUseId, r.replacement);
    }
  }
  if (inheritedReplacements) {
    for (const [id, replacement] of inheritedReplacements) {
      if (candidateIds.has(id) && !state.replacements.has(id)) {
        state.replacements.set(id, replacement);
      }
    }
  }
  return state;
}

export function reconstructForSubagentResume(
  parentState: ContentReplacementState | undefined,
  resumedMessages: Message[],
  sidechainRecords: ContentReplacementRecord[],
): ContentReplacementState | undefined {
  if (!parentState) return undefined;
  return reconstructContentReplacementState(
    resumedMessages,
    sidechainRecords,
    parentState.replacements,
  );
}
