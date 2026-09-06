import type { WorkflowDefinition } from "@/engine/background/workflows/runtime/registry/types.ts";
import {
  WORKFLOW_DESCRIPTION,
  WORKFLOW_NAME,
  WORKFLOW_PHASES,
  WORKFLOW_WHEN_TO_USE,
} from "./deep-security-review-contract.ts";
import { DEEP_SECURITY_REVIEW_SCRIPT } from "./deep-security-review-script.ts";

export const DEEP_SECURITY_REVIEW_WORKFLOW: WorkflowDefinition = {
  source: "built-in",
  name: WORKFLOW_NAME,
  description: WORKFLOW_DESCRIPTION,
  whenToUse: WORKFLOW_WHEN_TO_USE,
  phases: WORKFLOW_PHASES,
  script: DEEP_SECURITY_REVIEW_SCRIPT,
  hidden: true,
};
