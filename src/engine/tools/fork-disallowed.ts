const FORK_DISALLOWED = new Set([
  "AskUserQuestion",
  "ScheduleWakeup",
  "WaitForMcpServers",
  "Workflow",
]);

export function isForkDisallowedTool(name: string): boolean {
  return FORK_DISALLOWED.has(name);
}
