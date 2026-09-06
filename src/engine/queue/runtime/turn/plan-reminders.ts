import { existsSync } from "node:fs";
import { activePlanFilePath } from "@/engine/tools/plan-gate.ts";

export function planModeReminder(sessionId: string): string {
  const planFile = activePlanFilePath(sessionId);
  const planFileInfo = existsSync(planFile)
    ? `A plan file already exists at ${planFile}. You can read it and make incremental edits using the Edit tool.`
    : `No plan file exists yet. You should create your plan at ${planFile} using the Write tool.`;
  return `Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.

## Plan File Info:
${planFileInfo}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

When your plan is ready for approval, call ExitPlanMode.`;
}

export const EXITED_PLAN_MODE_REMINDER =
  "## Exited Plan Mode\n\nYou have exited plan mode. You can now make edits, run tools, and take actions.";
