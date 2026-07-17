export const ORCHESTRATION_MODE_VALUES = ["disabled", "default", "feudalism"] as const;

export type OrchestrationMode = (typeof ORCHESTRATION_MODE_VALUES)[number];

export const DEFAULT_ORCHESTRATION_MODE: OrchestrationMode = "disabled";

export function isOrchestrationMode(value: unknown): value is OrchestrationMode {
  return (
    typeof value === "string" && (ORCHESTRATION_MODE_VALUES as readonly string[]).includes(value)
  );
}

export function normalizeOrchestrationMode(value: unknown): OrchestrationMode {
  return isOrchestrationMode(value) ? value : DEFAULT_ORCHESTRATION_MODE;
}

export function orchestrationModeLabel(mode: OrchestrationMode): string {
  return mode;
}
