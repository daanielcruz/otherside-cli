import { getAgentContext } from "@/engine/agents/agent-context.ts";
import type { ForkSpec, SidechainRecord } from "./types.ts";

export function withSidechainMetadata(record: SidechainRecord, spec: ForkSpec): SidechainRecord {
  const context = getAgentContext();
  const next: SidechainRecord = { ...record, isSidechain: true };
  if (spec.parentToolCallId !== undefined) next.parentToolCallId = spec.parentToolCallId;
  if (context?.parentAgentId) next.parentAgentId = context.parentAgentId;
  if (typeof context?.depth === "number") next.agentDepth = context.depth;
  if (spec.agentId !== undefined) next.agentId = spec.agentId;
  return next;
}
