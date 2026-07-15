import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isErrno } from "@/kernel/std/errno.ts";

export interface WorkflowJournalResultEntry {
  type: "result";
  key: string;
  agentId: string;
  result: unknown;
}

export interface WorkflowJournalStartedEntry {
  type: "started";
  key: string;
  agentId: string;
}

export interface WorkflowJournalMetaEntry {
  type: "meta";
  args: unknown;
  scriptPath?: string;
}

export type WorkflowJournalEntry =
  | WorkflowJournalResultEntry
  | WorkflowJournalStartedEntry
  | WorkflowJournalMetaEntry;

export interface WorkflowJournalSnapshot {
  results: Map<string, WorkflowJournalResultEntry>;
  /** Prior dispatches that never produced a result, grouped by cache key. */
  started: Map<string, WorkflowJournalStartedEntry[]>;
  meta?: WorkflowJournalMetaEntry;
}

export function buildJournalSnapshot(entries: WorkflowJournalEntry[]): WorkflowJournalSnapshot {
  const results = new Map<string, WorkflowJournalResultEntry>();
  const started = new Map<string, WorkflowJournalStartedEntry[]>();
  let meta: WorkflowJournalMetaEntry | undefined;
  for (const entry of entries) {
    if (entry.type === "result") {
      results.set(entry.key, entry);
      continue;
    }
    if (entry.type === "started") {
      const existing = started.get(entry.key);
      if (existing) existing.push(entry);
      else started.set(entry.key, [entry]);
      continue;
    }
    if (entry.type === "meta") meta = entry;
  }
  return meta !== undefined ? { results, started, meta } : { results, started };
}

const JOURNAL_FILENAME = "journal.jsonl";

function isMissingFileError(error: unknown): boolean {
  return isErrno(error, "ENOENT");
}

export class WorkflowJournal {
  private readonly path: string;
  private dirReady = false;

  constructor(transcriptDir: string) {
    this.path = join(transcriptDir, JOURNAL_FILENAME);
  }

  async load(): Promise<WorkflowJournalSnapshot> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) return buildJournalSnapshot([]);
      throw error;
    }
    const entries: WorkflowJournalEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {}
    }
    return buildJournalSnapshot(entries);
  }

  async append(entry: WorkflowJournalEntry): Promise<void> {
    if (!this.dirReady) {
      await mkdir(dirname(this.path), { recursive: true });
      this.dirReady = true;
    }
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf8");
  }
}
