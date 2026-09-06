import type { SessionRecord } from "./record/index.ts";
import { chainHeadFromLines, recordsFromLines } from "./record-lines.ts";
import { readMainChainLines } from "./transcript-lines.ts";

export {
  chainHeadFromLines,
  recordsFromLines,
} from "./record-lines.ts";
export { readActiveChainLines } from "./resume-chain.ts";
export {
  loadSessionForResume,
  type ResumeLoad,
  SessionNotFoundError,
} from "./resume-load.ts";
export {
  readMainChainLines,
  readSessionLines,
  streamNonEmptyLines,
} from "./transcript-lines.ts";

export async function loadSession(id: string): Promise<SessionRecord[]> {
  return recordsFromLines(await readMainChainLines(id));
}

export async function loadSessionChainHead(id: string): Promise<string | null> {
  return chainHeadFromLines(await readMainChainLines(id));
}
