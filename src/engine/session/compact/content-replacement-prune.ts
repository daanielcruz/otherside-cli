import type { ContentReplacementSessionRecord } from "@/engine/session/record/schema.ts";
import type { Session } from "@/engine/session/record/state.ts";
import { reconstructContentReplacementState } from "@/engine/tool-result-storage/index.ts";

export function pruneContentReplacementStateForSession(session: Session): void {
  if (!session.contentReplacementState) return;
  const replacementRecords = session.records
    .filter(
      (record): record is ContentReplacementSessionRecord => record.type === "content_replacement",
    )
    .map((record) => ({
      kind: record.kind,
      toolUseId: record.toolUseId,
      replacement: record.replacement,
    }));
  session.contentReplacementState = reconstructContentReplacementState(
    session.messages,
    replacementRecords,
    session.contentReplacementState.replacements,
  );
}
