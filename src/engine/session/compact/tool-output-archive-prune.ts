import type { ToolOutputArchiveSessionRecord } from "@/engine/session/record/schema.ts";
import type { Session } from "@/engine/session/record/state.ts";
import { restoreToolOutputArchive } from "@/engine/tool-output-archive/index.ts";

export function pruneToolOutputArchiveForSession(session: Session): void {
  const archive = session.toolOutputArchive;
  if (!archive) return;

  const records = session.records
    .filter(
      (record): record is ToolOutputArchiveSessionRecord => record.type === "content_replacement",
    )
    .map((record) => ({
      kind: record.kind,
      toolUseId: record.toolUseId,
      replacement: record.replacement,
    }));
  session.toolOutputArchive = restoreToolOutputArchive(session.messages, records, archive.notices);
}
