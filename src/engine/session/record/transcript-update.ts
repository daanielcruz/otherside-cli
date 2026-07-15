import type { TranscriptEntry } from "@/engine/session/record/types.ts";

export interface AgentIdentity {
  model?: string | undefined;
  name?: string | undefined;
}

export function applyAgentIdentityToTranscript(
  entries: readonly TranscriptEntry[],
  callId: string,
  identity: AgentIdentity,
): readonly TranscriptEntry[] {
  const runningId = `t_${callId}`;
  const backgroundedId = `b_${callId}`;
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.id !== runningId && entry.id !== backgroundedId) return entry;
    let updated = entry;
    if (identity.model !== undefined && entry.agentModel !== identity.model) {
      updated = { ...updated, agentModel: identity.model };
    }
    if (identity.name !== undefined) {
      const text = withResolvedSubagentType(updated.text, identity.name);
      if (text !== null) updated = { ...updated, text };
    }
    if (updated !== entry) changed = true;
    return updated;
  });
  return changed ? next : entries;
}

export function applyAgentModelToTranscript(
  entries: readonly TranscriptEntry[],
  callId: string,
  model: string,
): readonly TranscriptEntry[] {
  return applyAgentIdentityToTranscript(entries, callId, { model });
}

// Tier dispatches carry no subagent_type in their input args; the resolved
// name only exists in runtime events. Stamp it into the entry's args text so
// the header keeps the name across backgrounding and resume. Explicit types
// (named agents, "fork") are never overwritten.
function withResolvedSubagentType(text: string, name: string): string | null {
  if (!text.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.subagent_type === "string" && obj.subagent_type.length > 0) return null;
  obj.subagent_type = name;
  return JSON.stringify(obj);
}
