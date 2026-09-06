import type { AgentEvent } from "@/kernel/std/types/events.ts";
import {
  isProviderId,
  type ProviderId,
  type ProviderModelRoute,
} from "@/kernel/std/types/provider-ids.ts";

export type AgentChipKind = "completed" | "failed" | "backgrounded" | "running" | "stopped";
export type AgentChipTaskKind = "agent" | "shell";

export interface AgentChipDescriptor {
  id: string;
  kind: AgentChipKind;
  taskKind: AgentChipTaskKind;
  description: string;
  subagentType?: string;
  model?: string;
  modelRoute?: ProviderModelRoute;
  producedModel?: string;
  producedRoute?: ProviderModelRoute;
  toolUses?: number;
  tokens?: number;
  durationMs?: number;
  exitCode?: number;
  reason?: string;
}

interface ParsedAgentResult {
  status: string;
  description?: string;
  subagentType?: string;
  model?: string;
  provider?: ProviderId;
  toolUses?: number;
  tokens?: number;
  durationMs?: number;
  exitCode?: number;
  reason?: string;
}

const ACCEPTED_STATUSES = new Set<AgentChipKind>([
  "completed",
  "failed",
  "backgrounded",
  "stopped",
]);

export function agentChipFromEvent(
  event: AgentEvent,
): { id: string; chip: AgentChipDescriptor } | null {
  if (event.kind !== "tool_dispatch_complete") return null;
  if (event.name !== "Agent" && event.name !== "Bash") return null;
  const taskKind: AgentChipTaskKind = event.name === "Bash" ? "shell" : "agent";
  const parsed = parseAgentResult(event.content);
  if (!parsed) return null;
  if (event.name === "Bash" && parsed.subagentType === undefined) return null;
  const status = resolveChipKind(parsed.status, event.isError);
  return {
    id: `${taskKind}_${event.id}`,
    chip: {
      id: event.id,
      kind: status,
      taskKind,
      description: parsed.description ?? "",
      ...(parsed.subagentType ? { subagentType: parsed.subagentType } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.model && parsed.provider
        ? { modelRoute: { provider: parsed.provider, model: parsed.model } }
        : {}),
      ...(parsed.toolUses !== undefined ? { toolUses: parsed.toolUses } : {}),
      ...(parsed.tokens !== undefined ? { tokens: parsed.tokens } : {}),
      ...(parsed.durationMs !== undefined ? { durationMs: parsed.durationMs } : {}),
      ...(parsed.exitCode !== undefined ? { exitCode: parsed.exitCode } : {}),
      ...(parsed.reason ? { reason: parsed.reason } : {}),
    },
  };
}

export function formatDurationMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  return `${minutes}m ${totalSec % 60}s`;
}

function resolveChipKind(parsedStatus: string, isError: boolean): AgentChipKind {
  if (ACCEPTED_STATUSES.has(parsedStatus as AgentChipKind)) return parsedStatus as AgentChipKind;
  return isError ? "failed" : "completed";
}

function parseAgentResult(content: string): ParsedAgentResult | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const providerValue = obj.resolvedProvider ?? obj.provider;
  const provider =
    typeof providerValue === "string" && isProviderId(providerValue) ? providerValue : null;
  return {
    status: typeof obj.status === "string" ? obj.status : "unknown",
    ...(typeof obj.description === "string" ? { description: obj.description } : {}),
    ...(typeof obj.subagent_type === "string" ? { subagentType: obj.subagent_type } : {}),
    ...(typeof obj.resolvedModel === "string" ? { model: obj.resolvedModel } : {}),
    ...(provider !== null ? { provider } : {}),
    ...(typeof obj.totalToolUseCount === "number" ? { toolUses: obj.totalToolUseCount } : {}),
    ...(typeof obj.totalTokens === "number" ? { tokens: obj.totalTokens } : {}),
    ...(typeof obj.totalDurationMs === "number" ? { durationMs: obj.totalDurationMs } : {}),
    ...(typeof obj.exitCode === "number" ? { exitCode: obj.exitCode } : {}),
    ...(typeof obj.reason === "string" ? { reason: obj.reason } : {}),
  };
}
