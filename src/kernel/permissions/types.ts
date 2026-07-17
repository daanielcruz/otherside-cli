import { sep } from "node:path";

export type PermissionRuleSource =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "flagSettings"
  | "policySettings"
  | "cliArg"
  | "command"
  | "session"
  | "toolsNarrowing";

export type PermissionBehavior = "allow" | "ask" | "deny";

export interface PermissionRuleValue {
  toolName: string;
  ruleContent?: string;
}

export interface PermissionRule {
  source: PermissionRuleSource;
  ruleBehavior: PermissionBehavior;
  ruleValue: PermissionRuleValue;
}

export type SettingsPermissionsBlock = {
  allow?: string[];
  ask?: string[];
  deny?: string[];
  additionalDirectories?: string[];
};

export const PERMISSION_RULE_SOURCES: PermissionRuleSource[] = [
  "userSettings",
  "projectSettings",
  "localSettings",
  "flagSettings",
  "policySettings",
  "cliArg",
  "command",
  "session",
  "toolsNarrowing",
];

export const READ_ONLY_PERMISSION_SOURCES: ReadonlySet<PermissionRuleSource> = new Set([
  "flagSettings",
  "policySettings",
  "command",
  "session",
  "toolsNarrowing",
]);

function escapeRuleContent(content: string): string {
  // Escaping order matters: backslashes must be escaped first, then
  // parentheses, so a trailing literal backslash never masquerades as an
  // escape for the closing paren delimiter.
  return content.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function unescapeRuleContent(content: string): string {
  // Reverse of escapeRuleContent: unescape parentheses first, then collapse
  // doubled backslashes last.
  return content.replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\");
}

// A character is escaped only if preceded by an odd number of consecutive
// backslashes, so a trailing single backslash does not
// falsely "escape" a following delimiter, and a trailing double backslash
// (an escaped backslash) does not falsely escape it either.
function isEscapedAt(s: string, i: number): boolean {
  let backslashCount = 0;
  let j = i - 1;
  while (j >= 0 && s[j] === "\\") {
    backslashCount++;
    j--;
  }
  return backslashCount % 2 === 1;
}

function findFirstUnescaped(s: string, ch: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch && !isEscapedAt(s, i)) return i;
  }
  return -1;
}

function findLastUnescaped(s: string, ch: string): number {
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === ch && !isEscapedAt(s, i)) return i;
  }
  return -1;
}

// Maps legacy tool names to their current canonical names. When a tool is
// renamed, add old -> new here so persisted permission rules (e.g. a `deny`
// entry written against the old name) continue to cover the canonical tool.
const LEGACY_TOOL_NAME_ALIASES: Record<string, string> = {
  Task: "Agent",
};

function normalizeLegacyToolName(name: string): string {
  return LEGACY_TOOL_NAME_ALIASES[name] ?? name;
}

export function permissionRuleValueFromString(s: string): PermissionRuleValue | null {
  const trimmed = s.trim();
  if (trimmed.length === 0) return null;
  const openIdx = findFirstUnescaped(trimmed, "(");
  const closeIdx = findLastUnescaped(trimmed, ")");
  if (openIdx >= 0 && closeIdx > openIdx) {
    if (closeIdx !== trimmed.length - 1) {
      // Trailing text after the closing parenthesis makes this an invalid
      // parenthesized rule (e.g. "Bash(echo *)junk"). Preserve the entire
      // string as the tool name rather than silently dropping the trailing
      // content: the matching unescaped close must be the final character.
      return { toolName: normalizeLegacyToolName(trimmed) };
    }
    const toolName = normalizeLegacyToolName(trimmed.slice(0, openIdx).trim());
    if (toolName.length === 0) return null;
    const raw = trimmed.slice(openIdx + 1, closeIdx);
    const ruleContent = unescapeRuleContent(raw.trim());
    // Empty content ("Bash()") and a bare "*" ("mcp__server(*)") both mean
    // "match the whole tool"
    // (rawContent === '' || rawContent === '*'). Without this, a whole-server
    // MCP wildcard rule like mcp__untrusted(*) would keep a ruleContent of
    // "*" and get silently discarded by the MCP content guard in
    // ruleMatches, causing an explicit allow/ask/deny to never match.
    return ruleContent.length === 0 || ruleContent === "*"
      ? { toolName }
      : { toolName, ruleContent };
  }
  const idx = trimmed.indexOf(":");
  if (idx < 0) return { toolName: normalizeLegacyToolName(trimmed) };
  const toolName = normalizeLegacyToolName(trimmed.slice(0, idx).trim());
  const ruleContent = trimmed.slice(idx + 1).trim();
  if (toolName.length === 0) return null;
  if (ruleContent.length === 0) return { toolName };
  return { toolName, ruleContent };
}

export function permissionRuleValueToString(v: PermissionRuleValue): string {
  return v.ruleContent ? `${v.toolName}(${escapeRuleContent(v.ruleContent)})` : v.toolName;
}

export function permissionDirectoryGlob(directory: string): string {
  const base = directory.endsWith(sep) ? directory.slice(0, -1) : directory;
  const escapedDirectory = base.replaceAll("\\", "\\\\").replaceAll("*", "\\*");
  const escapedSeparator = sep === "\\" ? "\\\\" : sep;
  return `${escapedDirectory}${escapedSeparator}*`;
}

export type PermissionUpdate =
  | {
      type: "addRules";
      rules: PermissionRule[];
      destination: PermissionRuleSource;
    }
  | {
      type: "removeRules";
      rules: PermissionRule[];
      source: PermissionRuleSource;
    }
  | { type: "setMode"; mode: "default" | "accept-edits" | "plan" | "yolo" }
  | { type: "addDirectories"; dirs: string[]; destination?: PermissionRuleSource }
  | { type: "removeDirectories"; dirs: string[]; destination?: PermissionRuleSource };
