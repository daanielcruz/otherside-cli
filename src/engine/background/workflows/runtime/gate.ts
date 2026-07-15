import type { UserConfig } from "@/kernel/config/config.ts";

const ENABLE_WORKFLOWS_DEFAULT = true;

export function isWorkflowEnabled(config: UserConfig): boolean {
  return config.enableWorkflows ?? ENABLE_WORKFLOWS_DEFAULT;
}
