export const SILENT_TOOL_NAMES = [
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "ToolSearch",
] as const;

export type SilentToolName = (typeof SILENT_TOOL_NAMES)[number];

export const SILENT_TOOL_NAME_SET: ReadonlySet<string> = new Set(SILENT_TOOL_NAMES);
