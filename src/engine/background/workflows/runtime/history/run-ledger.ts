import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isErrno } from "@/kernel/std/errno.ts";

export interface WorkflowOutputRecord {
  type: "result";
  key: string;
  agentId: string;
  result: unknown;
}

export interface WorkflowDispatchRecord {
  type: "started";
  key: string;
  agentId: string;
}

export interface WorkflowRunMetadataRecord {
  type: "meta";
  args: unknown;
  scriptPath?: string;
}

export type WorkflowRunRecord =
  | WorkflowOutputRecord
  | WorkflowDispatchRecord
  | WorkflowRunMetadataRecord;

export interface WorkflowRecoveryIndex {
  outputsByCacheKey: Map<string, WorkflowOutputRecord>;
  /** Dispatches without a matching output remain useful for resume diagnostics. */
  dispatchesByCacheKey: Map<string, WorkflowDispatchRecord[]>;
  runMetadata?: WorkflowRunMetadataRecord;
}

function collectOutput(
  record: WorkflowRunRecord,
  outputIndex: Map<string, WorkflowOutputRecord>,
): boolean {
  if (record.type !== "result") return false;
  outputIndex.set(record.key, record);
  return true;
}

function collectDispatch(
  record: WorkflowRunRecord,
  dispatchIndex: Map<string, WorkflowDispatchRecord[]>,
): boolean {
  if (record.type !== "started") return false;
  const dispatchesForKey = dispatchIndex.get(record.key);
  if (dispatchesForKey === undefined) dispatchIndex.set(record.key, [record]);
  else dispatchesForKey.push(record);
  return true;
}

function nextRunMetadata(
  record: WorkflowRunRecord,
  current: WorkflowRunMetadataRecord | undefined,
): WorkflowRunMetadataRecord | undefined {
  return record.type === "meta" ? record : current;
}

export function indexWorkflowRecords(records: WorkflowRunRecord[]): WorkflowRecoveryIndex {
  const outputsByCacheKey = new Map<string, WorkflowOutputRecord>();
  const dispatchesByCacheKey = new Map<string, WorkflowDispatchRecord[]>();
  let runMetadata: WorkflowRunMetadataRecord | undefined;

  for (const record of records) {
    if (collectOutput(record, outputsByCacheKey)) continue;
    if (collectDispatch(record, dispatchesByCacheKey)) continue;
    runMetadata = nextRunMetadata(record, runMetadata);
  }

  const recovered: WorkflowRecoveryIndex = { outputsByCacheKey, dispatchesByCacheKey };
  if (runMetadata !== undefined) recovered.runMetadata = runMetadata;
  return recovered;
}

const RUN_LOG_FILENAME = "journal.jsonl";
const UNREADABLE_ROW = Symbol();

function decodeRow(serialized: string): WorkflowRunRecord | typeof UNREADABLE_ROW {
  if (serialized.length === 0) return UNREADABLE_ROW;
  try {
    return JSON.parse(serialized);
  } catch {
    return UNREADABLE_ROW;
  }
}

function decodeJournalLines(document: string): WorkflowRunRecord[] {
  const records: WorkflowRunRecord[] = [];
  for (const serialized of document.split("\n")) {
    const decoded = decodeRow(serialized);
    if (decoded !== UNREADABLE_ROW) records.push(decoded);
  }
  return records;
}

async function readJournalText(fileLocation: string): Promise<string | null> {
  try {
    return await readFile(fileLocation, "utf8");
  } catch (failure) {
    if (isErrno(failure, "ENOENT")) return null;
    throw failure;
  }
}

export class WorkflowRunLedger {
  private readonly fileLocation: string;
  private directoryPrepared = false;

  constructor(runFolder: string) {
    this.fileLocation = join(runFolder, RUN_LOG_FILENAME);
  }

  async recoverIndex(): Promise<WorkflowRecoveryIndex> {
    const document = await readJournalText(this.fileLocation);
    if (document === null) return indexWorkflowRecords([]);
    return indexWorkflowRecords(decodeJournalLines(document));
  }

  async storeRecord(record: WorkflowRunRecord): Promise<void> {
    await this.prepareDirectory();
    const serialized = `${JSON.stringify(record)}\n`;
    await appendFile(this.fileLocation, serialized, "utf8");
  }

  private async prepareDirectory(): Promise<void> {
    if (this.directoryPrepared) return;
    await mkdir(dirname(this.fileLocation), { recursive: true });
    this.directoryPrepared = true;
  }
}
