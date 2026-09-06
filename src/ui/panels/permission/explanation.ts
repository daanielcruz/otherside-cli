import type { PendingPermission } from "@/kernel/channels/permission.ts";
import type { PermissionOptionKind, PermissionOptionRow } from "@/ui/panels/permission/options.ts";
import { styledProseLines, toolSignature } from "@/ui/panels/permission/tool-presentation.ts";
import { Color } from "@/ui/theme/theme.ts";

/**
 * The explanation section of the confirmation surface: the exact call being asked
 * about and what each answer commits to. Hidden until Ctrl+E asks for it, so the
 * options stay one screenful while the reader can still find out what they mean.
 */

const OPTION_EXPLANATIONS: Record<PermissionOptionKind, string> = {
  allow: "runs the call once; the next one asks again",
  allow_session: "runs it and matching calls for the rest of this session",
  allow_session_tool: "runs every call to this tool for the rest of this session",
  allow_session_edits: "runs edits without asking for the rest of this session",
  allow_always: "runs it and saves the rule to this project's settings",
  deny: "refuses the call and tells the agent so",
  plan_bypass: "leaves plan mode and stops asking before tool calls",
  plan_accept_edits: "leaves plan mode and approves edits automatically",
  plan_default: "leaves plan mode and asks before each edit",
  plan_feedback: "keeps the plan open and sends your note back to the agent",
};

export function explanationLines(input: {
  pending: Pick<PendingPermission, "toolName" | "argsPreview" | "rule">;
  options: readonly PermissionOptionRow[];
  width: number;
}): string[] {
  const { pending, options, width } = input;
  const lines = styledProseLines(`Call: ${toolSignature(pending)}`, width, Color.muted);
  if (pending.rule !== null && pending.rule !== undefined) {
    lines.push(...styledProseLines(`Rule: ${pending.rule}`, width, Color.muted));
  }
  for (const option of options) {
    lines.push(
      ...styledProseLines(`${option.key}. ${OPTION_EXPLANATIONS[option.kind]}`, width, Color.muted),
    );
  }
  return lines;
}
