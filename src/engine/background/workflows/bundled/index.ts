import { CODE_REVIEW_WORKFLOW } from "@/engine/background/workflows/bundled/code-review.ts";
import { DEEP_RESEARCH_WORKFLOW } from "@/engine/background/workflows/bundled/deep-research.ts";
import { DEEP_SECURITY_REVIEW_WORKFLOW } from "@/engine/background/workflows/bundled/deep-security-review.ts";
import { ULTRAPLAN_WORKFLOW } from "@/engine/background/workflows/bundled/ultraplan.ts";
import type { WorkflowDefinition } from "@/engine/background/workflows/runtime/registry/types.ts";
import { isEnvTruthy } from "@/kernel/std/proc/env.ts";

const BUNDLED_WORKFLOWS: WorkflowDefinition[] = [
  DEEP_RESEARCH_WORKFLOW,
  DEEP_SECURITY_REVIEW_WORKFLOW,
  CODE_REVIEW_WORKFLOW,
  ULTRAPLAN_WORKFLOW,
];

export function isBundledWorkflowsDisabled(): boolean {
  return isEnvTruthy(process.env.OTHERSIDE_DISABLE_BUNDLED_SKILLS);
}

export function getBundledWorkflows(): WorkflowDefinition[] {
  if (isBundledWorkflowsDisabled()) return [];
  return BUNDLED_WORKFLOWS;
}
