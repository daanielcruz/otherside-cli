import { renderWorkflowAgentSignature } from "@/engine/background/workflows/runtime/subagent/agent-options.ts";
import { resolveTierRosterData } from "@/engine/model/tier/roster-data.ts";
import {
  applyDefaultWorkflowModelGuidance,
  applyDisabledWorkflowModelGuidance,
  baseWorkflowDescription,
  buildWorkflowMultiproviderDescription,
  replaceWorkflowAgentSignature,
} from "@/harness/tools/Workflow/description.ts";
import { normalizeWorkflowSizeClass, type WorkflowSizeClass } from "@/kernel/config/config.ts";
import type { OrchestrationMode } from "@/kernel/std/types/orchestration-mode.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";

export function buildWorkflowDescription(
  activeProvider: ProviderId,
  orchestrationMode: OrchestrationMode = "disabled",
  workflowSizeGuideline?: WorkflowSizeClass,
): string {
  let description: string;
  if (orchestrationMode !== "feudalism") {
    const base = replaceWorkflowAgentSignature(
      baseWorkflowDescription(),
      renderWorkflowAgentSignature(orchestrationMode),
    );
    description =
      orchestrationMode === "default"
        ? applyDefaultWorkflowModelGuidance(base)
        : applyDisabledWorkflowModelGuidance(base);
  } else {
    description = buildWorkflowMultiproviderDescription({
      baseSignature: renderWorkflowAgentSignature("disabled"),
      multiproviderSignature: renderWorkflowAgentSignature("feudalism"),
      roster: resolveTierRosterData(activeProvider),
    });
  }
  return `${description}${workflowSizeGuidelineGuidance(workflowSizeGuideline)}`;
}

const WORKFLOW_SIZE_AGENT_CAPS: Record<Exclude<WorkflowSizeClass, "unrestricted">, number> = {
  small: 5,
  medium: 15,
  large: 50,
};

export function workflowSizeGuidelineGuidance(value: unknown): string {
  const guideline = normalizeWorkflowSizeClass(value);
  if (guideline === undefined) {
    return `

This session has the default workflow size guideline: medium — keep workflows under 15 agents. This is a guideline, not a hard limit — follow it unless the user's prompt calls for a different scale. The user can raise or remove it with "Dynamic workflow size" in /config.`;
  }
  if (guideline === "unrestricted") return "";
  const limit = WORKFLOW_SIZE_AGENT_CAPS[guideline];
  return `

A workflow size guideline is configured for this session: ${guideline} — keep workflows under ${limit} agents. This is a guideline, not a hard limit — follow it unless the user's prompt calls for a different scale.`;
}
