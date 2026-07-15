import { renderWorkflowAgentSignature } from "@/engine/background/workflows/runtime/subagent/agent-options.ts";
import { resolveTierRosterData } from "@/engine/model/tier/roster-data.ts";
import {
  baseWorkflowDescription,
  buildWorkflowMultiproviderDescription,
} from "@/harness/tools/Workflow/description.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";

export function buildWorkflowDescription(
  activeProvider: ProviderId,
  multiproviderEnabled: boolean,
): string {
  if (!multiproviderEnabled) return baseWorkflowDescription();
  return buildWorkflowMultiproviderDescription({
    baseSignature: renderWorkflowAgentSignature(false),
    multiproviderSignature: renderWorkflowAgentSignature(true),
    roster: resolveTierRosterData(activeProvider),
  });
}
