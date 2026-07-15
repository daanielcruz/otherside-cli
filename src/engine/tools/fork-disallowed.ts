const FORK_DISALLOWED = new Set([
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "ScheduleWakeup",
  "WaitForMcpServers",
  "Workflow",
]);

// Plan-mode agents must be able to hand their plan back for approval, so the
// definition-pinned plan mode lifts the ExitPlanMode block everywhere the
// fork roster is consulted (declarations, dispatch, ToolSearch catalog).
export function isForkDisallowedTool(
  name: string,
  permissionMode?: "default" | "accept-edits" | "plan" | "yolo",
): boolean {
  if (name === "ExitPlanMode" && permissionMode === "plan") return false;
  return FORK_DISALLOWED.has(name);
}
