import { resolveTierRosterData } from "@/engine/model/tier/roster-data.ts";
import type { ToolSchema } from "@/engine/tools/contract.ts";
import { orchestrationModeForAgentFields } from "@/engine/tools/dynamic/agent-options.ts";
import {
  buildAgentDescription,
  buildTierAwareAgentDescription as buildTierAwareAgentDescriptionFromRoster,
} from "@/harness/tools/Agent/description.ts";
import tool from "@/harness/tools/Agent/tool.json" with { type: "json" };
import { isAgentAutoBackgroundEnabled } from "@/kernel/config/agent-auto-background.ts";
import type { OrchestrationMode } from "@/kernel/std/types/orchestration-mode.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";

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
const DISABLED_MODEL_DESCRIPTION =
  "Concrete model override on the current provider. Takes precedence over the agent definition's model frontmatter. If omitted, uses the agent definition's model or inherits from the parent model. Not valid for subagent_type: \"fork\" — a fork route is a provider+model pair and `provider` is unavailable while orchestration is disabled, so a fork inherits the parent route.";
const FEUDALISM_FORK_MODEL_DESCRIPTION =
  'Concrete model id for subagent_type: "fork" only. Pass it together with `provider`; the fork runs that literal pair only after the user approves the extra cost. Omit both to inherit the parent route.';
const FEUDALISM_FORK_PROVIDER_DESCRIPTION =
  'Provider id for subagent_type: "fork" only. Pass it together with `model` to name a literal fork route; no model catalog is listed here.';

export function buildAgentInputSchema(
  provider?: ProviderId,
  orchestrationMode: OrchestrationMode = "disabled",
): Record<string, unknown> {
  const schema = structuredClone(tool.inputSchema) as Record<string, unknown>;
  const properties = {
    ...((schema.properties ?? {}) as Record<string, unknown>),
  };
  for (const field of orchestrationModeForAgentFields(orchestrationMode)) delete properties[field];
  if (orchestrationMode === "disabled" && properties.model !== undefined) {
    properties.model = {
      ...(properties.model as Record<string, unknown>),
      description: DISABLED_MODEL_DESCRIPTION,
    };
  }
  if (orchestrationMode === "feudalism") {
    properties.model = {
      ...(properties.model as Record<string, unknown>),
      description: FEUDALISM_FORK_MODEL_DESCRIPTION,
    };
    properties.provider = {
      ...(properties.provider as Record<string, unknown>),
      description: FEUDALISM_FORK_PROVIDER_DESCRIPTION,
    };
  }
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
