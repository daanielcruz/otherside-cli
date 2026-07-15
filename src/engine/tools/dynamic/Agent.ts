import { resolveTierRosterData } from "@/engine/model/tier/roster-data.ts";
import type { ToolSchema } from "@/engine/tools/contract.ts";
import {
  buildAgentDescription,
  buildTierAwareAgentDescription as buildTierAwareAgentDescriptionFromRoster,
} from "@/harness/tools/Agent/description.ts";
import tool from "@/harness/tools/Agent/tool.json" with { type: "json" };
import { isAgentAutoBackgroundEnabled } from "@/kernel/config/agent-auto-background.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";

export { buildAgentDescription };

export interface AgentRow {
  agentType: string;
  whenToUse: string;
  whenToUseLean?: string;
  toolsLabel: string;
}

export function formatAgentRow(row: AgentRow, lean = false): string {
  const blurb = lean ? (row.whenToUseLean ?? row.whenToUse) : row.whenToUse;
  return `- ${row.agentType}: ${blurb} (Tools: ${row.toolsLabel})`;
}

export function buildTierAwareAgentDescription(
  currentProvider: ProviderId,
  mainAgent = true,
): string {
  return buildTierAwareAgentDescriptionFromRoster(
    resolveTierRosterData(currentProvider),
    mainAgent,
  );
}

const WORKTREE_ISOLATION_DESCRIPTION =
  'Isolation mode. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo.';

export function buildAgentInputSchema(provider?: ProviderId): Record<string, unknown> {
  const schema = structuredClone(tool.inputSchema) as Record<string, unknown>;
  const properties = { ...((schema.properties ?? {}) as Record<string, unknown>) };
  if (isAgentAutoBackgroundEnabled()) delete properties.run_in_background;
  if (provider !== "anthropic") {
    properties.isolation = {
      description: WORKTREE_ISOLATION_DESCRIPTION,
      type: "string",
      enum: ["worktree"],
    };
  }
  return { ...schema, properties };
}

// Local execution keeps the superset so unsupported provider-visible values can
// reach Agent.run and return a precise error. The translator builds the narrower
// per-provider wire schema through buildAgentInputSchema on every request.
export const AgentSchema = {
  name: tool.name,
  description: buildAgentDescription({ lean: true }),
  inputSchema: tool.inputSchema,
} satisfies ToolSchema;

export const AGENT_INPUT_SCHEMA_SHARED = tool.inputSchema;
