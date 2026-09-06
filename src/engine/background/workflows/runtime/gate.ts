import type { UserConfig } from "@/kernel/config/config.ts";

const ENABLE_WORKFLOWS_DEFAULT = true;

export function isWorkflowEnabled(config: UserConfig): boolean {
  return config.enableWorkflows ?? ENABLE_WORKFLOWS_DEFAULT;
}

/**
 * Whether writing the keyword in a prompt opts that turn into orchestration.
 *
 * On by default, and worth turning off: someone writing about the feature
 * rather than asking for it should not have their turn opted in by the word.
 */
export function isWorkflowKeywordTriggerEnabled(config: UserConfig): boolean {
  return config.workflowKeywordTrigger ?? KEYWORD_TRIGGER_DEFAULT;
}

const KEYWORD_TRIGGER_DEFAULT = true;
