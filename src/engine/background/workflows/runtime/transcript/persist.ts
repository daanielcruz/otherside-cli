import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getWorkflowTranscriptDir } from "@/engine/background/workflows/runtime/history/paths.ts";
import type { AgentTranscript } from "@/engine/background/workflows/runtime/transcript/types.ts";
import { isErrno } from "@/kernel/std/errno.ts";

const AGENT_TRANSCRIPTS_FILENAME = "agent-transcripts.jsonl";

export interface WorkflowRunLocator {
  cwd: string;
  sessionId: string;
  runId: string;
}

function transcriptsPath(locator: WorkflowRunLocator): string {
  return join(
    getWorkflowTranscriptDir(locator.cwd, locator.sessionId, locator.runId),
    AGENT_TRANSCRIPTS_FILENAME,
  );
}

function isMissingFileError(error: unknown): boolean {
  return isErrno(error, "ENOENT");
}

function parseTranscript(line: string): AgentTranscript | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record: Record<string, unknown> = Object(parsed);
    if (typeof record.agentId !== "string") return null;
    if (typeof record.prompt !== "string") return null;
    if (typeof record.finalText !== "string") return null;
    if (!Array.isArray(record.toolCalls)) return null;
    return parsed as AgentTranscript;
  } catch {
    return null;
  }
}

export async function persistAgentTranscripts(
  locator: WorkflowRunLocator,
  transcripts: AgentTranscript[],
): Promise<void> {
  if (transcripts.length === 0) return;
  try {
    const path = transcriptsPath(locator);
    await mkdir(dirname(path), { recursive: true });
    const body = transcripts.map((entry) => JSON.stringify(entry)).join("\n");
    await writeFile(path, `${body}\n`, "utf8");
  } catch {}
}

export async function loadAgentTranscripts(
  locator: WorkflowRunLocator,
): Promise<Map<string, AgentTranscript>> {
  const result = new Map<string, AgentTranscript>();
  let raw: string;
  try {
    raw = await readFile(transcriptsPath(locator), "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return result;
    return result;
  }
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const parsed = parseTranscript(line);
    if (parsed !== null) result.set(parsed.agentId, parsed);
  }
  return result;
}

export async function fetchAgentTranscript(
  locator: WorkflowRunLocator,
  agentId: string,
): Promise<AgentTranscript | null> {
  const all = await loadAgentTranscripts(locator);
  return all.get(agentId) ?? null;
}
