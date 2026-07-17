import { renderWorkflowAgentSignature } from "@/engine/background/workflows/runtime/subagent/agent-options.ts";
import { resolveTierRosterData } from "@/engine/model/tier/roster-data.ts";
import {
  applyDefaultWorkflowModelGuidance,
  applyDisabledWorkflowModelGuidance,
  baseWorkflowDescription,
  buildWorkflowMultiproviderDescription,
  replaceWorkflowAgentSignature,
} from "@/harness/tools/Workflow/description.ts";
import {
  normalizeWorkflowSizeGuideline,
  type WorkflowSizeGuideline,
} from "@/kernel/config/config.ts";
import type { OrchestrationMode } from "@/kernel/config/orchestration-mode.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";

export function buildWorkflowDescription(
  activeProvider: ProviderId,
  orchestrationMode: OrchestrationMode = "disabled",
  workflowSizeGuideline: WorkflowSizeGuideline | undefined = "unrestricted",
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

export function workflowSizeGuidelineGuidance(value: unknown): string {
  const guideline = normalizeWorkflowSizeGuideline(value);
  if (guideline === "unrestricted") return "";
  const limit = guideline === "small" ? 5 : guideline === "medium" ? 15 : 50;
  return `

The user configured the ${guideline} workflow size guideline in /config. Keep workflows under ${limit} agents. This is advisory, not a runtime limit: follow it unless the user's request clearly calls for a different scale, and warn the user before launching a larger workflow.`;
}
