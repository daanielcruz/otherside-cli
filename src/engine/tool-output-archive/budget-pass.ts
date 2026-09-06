import type { Message, ToolResultContentBlock } from "@/kernel/std/types/message.ts";
import type { ToolOutputArchive } from "@/kernel/std/types/request.ts";
import { TURN_OUTPUT_CHARACTER_LIMIT } from "./contract.ts";
import {
  archiveToolOutput,
  containsImageOutput,
  formatArchivedOutputNotice,
  isArchivedOutputNotice,
  isToolOutputArchiveError,
  toolOutputCharacterCount,
} from "./files.ts";

export type { ToolOutputArchive } from "@/kernel/std/types/request.ts";

export type ToolOutputArchiveRecord = {
  kind: "tool-result";
  toolUseId: string;
  replacement: string;
};

export type NewToolOutputArchiveRecord = Extract<ToolOutputArchiveRecord, { kind: "tool-result" }>;

interface OutputCandidate {
  callId: string;
  content: string | ToolResultContentBlock[];
  characters: number;
}

interface CandidateInventory {
  restored: Array<OutputCandidate & { notice: string }>;
  settled: OutputCandidate[];
  pending: OutputCandidate[];
}

interface ArchivePlan {
  notices: Map<string, string>;
  pending: OutputCandidate[];
}

export function createToolOutputArchive(): ToolOutputArchive {
  return { observedCallIds: new Set(), notices: new Map() };
}

export function copyToolOutputArchive(source: ToolOutputArchive): ToolOutputArchive {
  return {
    observedCallIds: new Set(source.observedCallIds),
    notices: new Map(source.notices),
  };
}

export function turnToolOutputCharacterLimit(): number {
  return TURN_OUTPUT_CHARACTER_LIMIT;
}

export async function enforceToolOutputBudget(
  messages: Message[],
  archive: ToolOutputArchive,
  excludedTools: ReadonlySet<string> = new Set(["Read"]),
): Promise<{
  messages: Message[];
  records: NewToolOutputArchiveRecord[];
}> {
  const plan = planToolOutputArchive(messages, archive, excludedTools);
  if (plan.notices.size === 0 && plan.pending.length === 0) {
    return { messages, records: [] };
  }

  const stored = await Promise.all(
    plan.pending.map(async (candidate) => ({
      candidate,
      notice: await archiveCandidate(candidate),
    })),
  );
  const records: NewToolOutputArchiveRecord[] = [];
  for (const { candidate, notice } of stored) {
    archive.observedCallIds.add(candidate.callId);
    if (notice === null) continue;
    plan.notices.set(candidate.callId, notice);
    archive.notices.set(candidate.callId, notice);
    records.push({ kind: "tool-result", toolUseId: candidate.callId, replacement: notice });
  }

  return {
    messages: plan.notices.size > 0 ? injectArchiveNotices(messages, plan.notices) : messages,
    records,
  };
}

function planToolOutputArchive(
  messages: Message[],
  archive: ToolOutputArchive,
  excludedTools: ReadonlySet<string>,
): ArchivePlan {
  const toolNames = collectToolNames(messages);
  const notices = new Map<string, string>();
  const pending: OutputCandidate[] = [];

  for (const turn of collectOutputTurns(messages)) {
    const inventory = inventoryCandidates(turn, archive);
    for (const candidate of inventory.restored) notices.set(candidate.callId, candidate.notice);

    if (inventory.pending.length === 0) {
      markObserved(archive, turn);
      continue;
    }

    const eligible: OutputCandidate[] = [];
    for (const candidate of inventory.pending) {
      if (excludedTools.has(toolNames.get(candidate.callId) ?? "")) {
        archive.observedCallIds.add(candidate.callId);
      } else {
        eligible.push(candidate);
      }
    }

    const settledCharacters = totalCharacters(inventory.settled);
    const eligibleCharacters = totalCharacters(eligible);
    const selected =
      settledCharacters + eligibleCharacters > turnToolOutputCharacterLimit()
        ? chooseCandidatesForArchive(eligible, settledCharacters)
        : [];
    const selectedIds = new Set(selected.map((candidate) => candidate.callId));
    for (const candidate of turn) {
      if (!selectedIds.has(candidate.callId)) archive.observedCallIds.add(candidate.callId);
    }
    pending.push(...selected);
  }

  return { notices, pending };
}

function collectOutputTurns(messages: Message[]): OutputCandidate[][] {
  const turns: OutputCandidate[][] = [];
  let current: OutputCandidate[] = [];
  const assistantIds = new Set<string>();

  for (const message of messages) {
    if (message.role === "user") {
      current.push(...outputCandidates(message));
      continue;
    }
    if (message.role !== "assistant") continue;

    const id = message.id ?? "";
    if (id !== "" && assistantIds.has(id)) continue;
    if (current.length > 0) turns.push(current);
    current = [];
    if (id !== "") assistantIds.add(id);
  }

  if (current.length > 0) turns.push(current);
  return turns;
}

function outputCandidates(message: Message): OutputCandidate[] {
  if (message.role !== "user" || !Array.isArray(message.content)) return [];

  const candidates: OutputCandidate[] = [];
  for (const block of message.content) {
    if (block.type !== "tool_result" || !block.content) continue;
    if (isArchivedOutputNotice(block.content) || containsImageOutput(block.content)) continue;
    candidates.push({
      callId: block.tool_use_id,
      content: block.content,
      characters: toolOutputCharacterCount(block.content),
    });
  }
  return candidates;
}

function collectToolNames(messages: Message[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use") names.set(block.id, block.name);
    }
  }
  return names;
}

function inventoryCandidates(
  candidates: OutputCandidate[],
  archive: ToolOutputArchive,
): CandidateInventory {
  const restored = candidates.flatMap((candidate) => {
    const notice = archive.notices.get(candidate.callId);
    return notice === undefined ? [] : [{ ...candidate, notice }];
  });
  const unarchived = candidates.filter((candidate) => !archive.notices.has(candidate.callId));
  const settled = unarchived.filter((candidate) => archive.observedCallIds.has(candidate.callId));
  const pending = unarchived.filter((candidate) => !archive.observedCallIds.has(candidate.callId));
  return { restored, settled, pending };
}

function chooseCandidatesForArchive(
  candidates: OutputCandidate[],
  settledCharacters: number,
): OutputCandidate[] {
  let retainedCharacters = settledCharacters + totalCharacters(candidates);
  const selected: OutputCandidate[] = [];
  const largestFirst = [...candidates].sort((left, right) => right.characters - left.characters);
  for (const candidate of largestFirst) {
    if (retainedCharacters <= turnToolOutputCharacterLimit()) break;
    retainedCharacters -= candidate.characters;
    selected.push(candidate);
  }
  return selected;
}

function totalCharacters(candidates: OutputCandidate[]): number {
  let total = 0;
  for (const candidate of candidates) total += candidate.characters;
  return total;
}

function markObserved(archive: ToolOutputArchive, candidates: OutputCandidate[]): void {
  for (const candidate of candidates) archive.observedCallIds.add(candidate.callId);
}

function injectArchiveNotices(
  messages: Message[],
  notices: ReadonlyMap<string, string>,
): Message[] {
  const output: Message[] = [];
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) {
      output.push(message);
      continue;
    }

    let changed = false;
    const content = message.content.map((block) => {
      if (block.type !== "tool_result") return block;
      const notice = notices.get(block.tool_use_id);
      if (notice === undefined) return block;
      changed = true;
      return { ...block, content: notice };
    });
    output.push(changed ? { ...message, content } : message);
  }
  return output;
}

async function archiveCandidate(candidate: OutputCandidate): Promise<string | null> {
  const output = await archiveToolOutput(candidate.content, candidate.callId);
  return isToolOutputArchiveError(output) ? null : formatArchivedOutputNotice(output);
}

export async function applyToolOutputBudget(
  messages: Message[],
  archive: ToolOutputArchive | undefined,
  record?: (records: NewToolOutputArchiveRecord[]) => void,
  excludedTools?: ReadonlySet<string>,
): Promise<Message[]> {
  if (!archive) return messages;
  const result = await enforceToolOutputBudget(messages, archive, excludedTools);
  if (result.records.length > 0) record?.(result.records);
  return result.messages;
}

export function restoreToolOutputArchive(
  messages: Message[],
  records: ToolOutputArchiveRecord[],
  inheritedNotices?: ReadonlyMap<string, string>,
): ToolOutputArchive {
  const archive = createToolOutputArchive();
  const activeCallIds = new Set<string>();
  for (const turn of collectOutputTurns(messages)) {
    for (const candidate of turn) activeCallIds.add(candidate.callId);
  }
  for (const callId of activeCallIds) archive.observedCallIds.add(callId);

  for (const record of records) {
    if (record.kind === "tool-result" && activeCallIds.has(record.toolUseId)) {
      archive.notices.set(record.toolUseId, record.replacement);
    }
  }
  if (inheritedNotices) {
    for (const [callId, notice] of inheritedNotices) {
      if (activeCallIds.has(callId) && !archive.notices.has(callId)) {
        archive.notices.set(callId, notice);
      }
    }
  }
  return archive;
}

export function restoreResumedToolOutputArchive(
  parent: ToolOutputArchive | undefined,
  messages: Message[],
  records: ToolOutputArchiveRecord[],
): ToolOutputArchive | undefined {
  return parent ? restoreToolOutputArchive(messages, records, parent.notices) : undefined;
}
