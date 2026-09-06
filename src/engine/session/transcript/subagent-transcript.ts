import { stat } from "node:fs/promises";
import { hydratePreservedImages } from "@/engine/session/compact/preserved-image-ledger.ts";
import { reconstructForeignConversation } from "@/engine/session/conversation-chain.ts";
import { agentTranscriptPathForCwd } from "@/engine/session/paths.ts";
import { recordsFromParsedLine, type SessionRecord } from "@/engine/session/record/index.ts";
import { parseLineEnvelope } from "@/engine/session/transcript/truncate.ts";

export interface SubagentTranscriptRef {
  cwd: string;
  sessionId: string;
  forkId: string;
}

function stripSidechain(record: SessionRecord): SessionRecord {
  if (!("isSidechain" in record) || record.isSidechain !== true) return record;
  return { ...record, isSidechain: false };
}

async function readLines(path: string): Promise<string[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const text = await file.text();
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length > 0) lines.push(line);
  }
  return lines;
}

export async function loadSubagentTranscript(ref: SubagentTranscriptRef): Promise<SessionRecord[]> {
  const path = agentTranscriptPathForCwd(ref.cwd, ref.sessionId, ref.forkId);
  const lines = await readLines(path);
  // Foreign subagent transcripts reconstruct through the parentUuid walk, which prunes abandoned branches. Native otherside files carry `_os`, so reconstructForeignConversation returns null and they are read in file order; that order is already the active chain because forks stay linear on disk, and it preserves otherside-specific content_replacement records.
  const foreignChain = reconstructForeignConversation(lines, { sidechain: true });
  const sources = foreignChain ?? lines.map(parseLineEnvelope);
  const out: SessionRecord[] = [];
  for (const source of sources) {
    if (!source) continue;
    for (const record of recordsFromParsedLine(source)) out.push(stripSidechain(record));
  }
  hydratePreservedImages([out]);
  return out;
}

export async function subagentTranscriptSize(ref: SubagentTranscriptRef): Promise<number> {
  try {
    return (await stat(agentTranscriptPathForCwd(ref.cwd, ref.sessionId, ref.forkId))).size;
  } catch {
    return 0;
  }
}
