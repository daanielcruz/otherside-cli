import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import type { ProviderId, ProviderModelRoute } from "@/kernel/std/types/provider-ids.ts";

export interface AgentIdentity {
  model?: string | undefined;
  provider?: ProviderId | undefined;
  route?: ProviderModelRoute | undefined;
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
    const route =
      identity.route ??
      (identity.provider !== undefined && identity.model !== undefined
        ? { provider: identity.provider, model: identity.model }
        : undefined);
    if (route !== undefined) {
      if (
        entry.agentRoute?.provider !== route.provider ||
        entry.agentRoute?.model !== route.model ||
        entry.agentModel !== route.model ||
        entry.agentProvider !== route.provider
      ) {
        updated = {
          ...updated,
          agentRoute: route,
          agentModel: route.model,
          agentProvider: route.provider,
        };
      }
    } else {
      if (identity.model !== undefined && entry.agentModel !== identity.model) {
        updated = { ...updated, agentModel: identity.model };
      }
      if (identity.provider !== undefined && updated.agentProvider !== identity.provider) {
        updated = { ...updated, agentProvider: identity.provider };
      }
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

export function resolveToolCompletion(
  entries: readonly TranscriptEntry[],
  input: {
    readonly runningId: string;
    readonly backgroundedId: string;
    readonly resolved: TranscriptEntry;
  },
): readonly TranscriptEntry[] {
  const index = entries.findIndex(
    (entry) => entry.id === input.runningId || entry.id === input.backgroundedId,
  );
  if (index === -1) return [...entries, input.resolved];
  const next = [...entries];
  next[index] = input.resolved;
  return next;
}

export function rewriteClearedToolResults(
  entries: readonly TranscriptEntry[],
  clearedToolUseIds: ReadonlySet<string>,
  clearedMessage: string,
): readonly TranscriptEntry[] {
  return entries.map((entry) => {
    if (entry.kind !== "tool" || !entry.id.startsWith("r_")) return entry;
    if (!clearedToolUseIds.has(entry.id.slice(2))) return entry;
    return { ...entry, text: clearedMessage };
  });
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
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const existing = record.subagent_type;
  if (typeof existing === "string" && existing.length > 0 && existing !== "general-purpose") {
    return null;
  }
  return JSON.stringify({ ...record, subagent_type: name });
}
