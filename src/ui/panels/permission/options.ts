import { userFacingToolName } from "@/engine/tools/tool-label.ts";
import {
  type PendingPermission,
  type PermissionResult,
  PermissionResults,
} from "@/kernel/channels/permission.ts";

export type PermissionOptionKind =
  | "allow"
  | "allow_session"
  | "allow_session_tool"
  | "allow_session_edits"
  | "allow_always"
  | "deny"
  | "plan_bypass"
  | "plan_accept_edits"
  | "plan_default"
  | "plan_feedback";

export interface PermissionOptionRow {
  key: string;
  label: string;
  kind: PermissionOptionKind;
}

export function planOptionsFor(bypassAvailable: boolean): PermissionOptionRow[] {
  return [
    bypassAvailable
      ? { key: "1", label: "Yes, and bypass permissions", kind: "plan_bypass" }
      : { key: "1", label: "Yes, and use auto mode", kind: "plan_accept_edits" },
    { key: "2", label: "Yes, manually approve edits", kind: "plan_default" },
    { key: "3", label: "Tell Otherside what to change", kind: "plan_feedback" },
  ];
}

export function buildGenericOptions(
  rule: string | null,
  isDesign = false,
  toolName = "",
  readOnly = false,
  mcp: { label: string; cwd: string } | null = null,
): PermissionOptionRow[] {
  if (isDesign) {
    const options: PermissionOptionRow[] = [
      { key: "1", label: "Allow once (this turn)", kind: "allow" },
    ];
    if (rule) {
      options.push({
        key: "2",
        label: "Allow for this design session",
        kind: "allow_session",
      });
      if (readOnly) {
        options.push({
          key: String(options.length + 1),
          label: `Allow all ${userFacingToolName(toolName)} for this design session`,
          kind: "allow_session_tool",
        });
      }
      options.push({
        key: String(options.length + 1),
        label: `Always allow (persist for ${ruleDisplay(rule)})`,
        kind: "allow_always",
      });
      options.push({ key: String(options.length + 1), label: "Deny", kind: "deny" });
    } else {
      options.push({ key: "2", label: "Deny", kind: "deny" });
    }
    return options;
  }

  const options: PermissionOptionRow[] = [{ key: "1", label: "Yes", kind: "allow" }];
  if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(toolName)) {
    options.push({
      key: "2",
      label: "Yes, allow all edits during this session",
      kind: "allow_session_edits",
    });
    options.push({ key: "3", label: "No", kind: "deny" });
    return options;
  }
  if (readOnly && rule) {
    options.push({
      key: String(options.length + 1),
      label: "Yes, during this session",
      kind: "allow_session",
    });
  }
  if (rule && mcp !== null) {
    options.push({
      key: String(options.length + 1),
      label: `Yes, and don't ask again for ${mcp.label} commands in ${mcp.cwd}`,
      kind: "allow_always",
    });
  } else if (rule) {
    options.push({
      key: String(options.length + 1),
      label: `Yes, and don't ask again for ${ruleDisplay(rule)} in this project`,
      kind: "allow_always",
    });
  }
  options.push({ key: String(options.length + 1), label: "No", kind: "deny" });
  return options;
}

export function resultFor(
  kind: PermissionOptionKind,
  rule: string | null,
  toolName: string,
  feedback: string,
  editDirectory: string | null | undefined,
  suggestions: PendingPermission["suggestions"],
): PermissionResult {
  if (kind === "allow") {
    return feedback.length > 0 ? PermissionResults.allow(feedback) : PermissionResults.allow();
  }
  if (kind === "deny") {
    return feedback.length > 0 ? PermissionResults.deny(feedback) : PermissionResults.deny();
  }
  if (kind === "allow_session" && rule) {
    const result =
      suggestions === undefined
        ? PermissionResults.allowSession(rule)
        : PermissionResults.allowSession(rule, suggestions);
    return withFeedback(result, feedback);
  }
  if (kind === "allow_session_tool" && toolName) {
    return withFeedback(PermissionResults.allowSession(toolName), feedback);
  }
  if (kind === "allow_session_edits") {
    const result =
      editDirectory === undefined
        ? PermissionResults.allowSessionEdits()
        : PermissionResults.allowSessionEdits(editDirectory);
    return withFeedback(result, feedback);
  }
  if (kind === "allow_always" && rule) {
    return withFeedback(PermissionResults.allowAlways(rule), feedback);
  }
  if (kind === "allow_always") {
    return feedback.length > 0 ? PermissionResults.allow(feedback) : PermissionResults.allow();
  }
  if (kind === "plan_bypass") return PermissionResults.setMode("yolo");
  if (kind === "plan_accept_edits") return PermissionResults.setMode("accept-edits");
  if (kind === "plan_default") return PermissionResults.setMode("default");
  return PermissionResults.planFeedback(feedback);
}

function withFeedback(result: PermissionResult, feedback: string): PermissionResult {
  const trimmed = feedback.trim();
  return trimmed.length > 0 ? { ...result, feedback: trimmed } : result;
}

export function bashRuleContentOf(rule: string): string {
  const openIdx = rule.indexOf("(");
  const closeIdx = rule.lastIndexOf(")");
  if (openIdx >= 0 && closeIdx > openIdx) return rule.slice(openIdx + 1, closeIdx).trim();
  const colonIdx = rule.indexOf(":");
  return colonIdx >= 0 ? rule.slice(colonIdx + 1).trim() : "";
}

function ruleDisplay(rule: string): string {
  const colonIdx = rule.indexOf(":");
  if (colonIdx < 0) return rule;
  const tool = rule.slice(0, colonIdx);
  const content = rule.slice(colonIdx + 1).trim();
  if (content.length === 0) return tool;
  const compact = content.length > 48 ? `${content.slice(0, 48)}…` : content;
  return `${tool}(${compact})`;
}
