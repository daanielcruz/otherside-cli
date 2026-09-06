import { isTranscriptLinked, KNOWN_TYPES, type RecordType } from "./record/index.ts";

const CHAIN_PARTICIPANT_LINE_TYPES = new Set(["user", "assistant", "attachment"]);

export function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function hasCompactionSummary(envelope: Record<string, unknown>): boolean {
  const sidecar = objectRecord(objectRecord(envelope._os)?.compaction);
  if (sidecar !== null && "summaryRef" in sidecar) return hasSummaryRef(sidecar.summaryRef);
  if ("summary_ref" in envelope) return hasSummaryRef(envelope.summary_ref);
  if ("summary" in envelope) return hasSummaryRef(envelope.summary);
  const content = envelope.content;
  return (
    typeof content === "string" &&
    content.trim().length > 0 &&
    content.trim() !== "Conversation compacted"
  );
}

function hasSummaryRef(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  const record = objectRecord(value);
  return (
    record?.kind === "spilled_compaction_summary" &&
    typeof record.filepath === "string" &&
    record.filepath.length > 0
  );
}

export function isSessionMetaEnvelope(envelope: Record<string, unknown>): boolean {
  if (envelope.type === "session_meta") return true;
  if (envelope.type !== "system") return false;
  return (
    envelope.subtype === "otherside-config" || objectRecord(envelope._os)?.type === "session_meta"
  );
}

export function isChainEnvelope(envelope: Record<string, unknown>): boolean {
  if (typeof envelope.type !== "string") return false;
  if (!("_os" in envelope)) return isChainParticipantLine(envelope);
  const recordType = nativeRecordType(envelope._os);
  return recordType === null ? isChainParticipantLine(envelope) : isTranscriptLinked(recordType);
}

export function isChainParticipantLine(envelope: Record<string, unknown>): boolean {
  if (typeof envelope.type !== "string") return false;
  if (CHAIN_PARTICIPANT_LINE_TYPES.has(envelope.type)) return true;
  return envelope.type === "system" && envelope.subtype === "compact_boundary";
}

export function nativeRecordType(sidecar: unknown): RecordType | null {
  if (!sidecar || typeof sidecar !== "object") return null;
  const type = (sidecar as Record<string, unknown>).type;
  if (typeof type !== "string") return null;
  return KNOWN_TYPES.has(type as RecordType) ? (type as RecordType) : null;
}
