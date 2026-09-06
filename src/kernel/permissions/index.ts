export type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleValue,
  RuleSourceScope,
  SettingsPermissionsBlock,
} from "@/kernel/permissions/types.ts";
export {
  PERMISSION_RULE_SOURCES,
  parseRuleValueText,
  permissionDirectoryGlob,
  READ_ONLY_PERMISSION_SOURCES,
  serializeRuleValue,
} from "@/kernel/permissions/types.ts";

import {
  allowRuleCoversDangerousFind,
  containsUnsafeRedirect,
  isCompoundForGuard,
  looksLikeXargsCarrier,
  stripHeredocBody,
  stripLeadingEnvAssignments,
  stripLeadingSafeEnvVars,
  stripSafeWrappers,
} from "@/kernel/permissions/bash-matcher.ts";
import { splitBashSubcommands } from "@/kernel/permissions/sensitive-paths.ts";
import type { PermissionBehavior, PermissionRule } from "@/kernel/permissions/types.ts";

// `cliArg` and `toolsNarrowing` rules are scoped overrides that must not be
// widened via tool-alias expansion — only first-class rule sources get
// alias matching.
function sourceSupportsAliasExpansion(rule: PermissionRule): boolean {
  return rule.source !== "cliArg" && rule.source !== "toolsNarrowing";
}

export function hasWholeToolDenyRule(rules: readonly PermissionRule[], toolName: string): boolean {
  return rules.some(
    (rule) =>
      rule.ruleBehavior === "deny" &&
      rule.ruleValue.ruleContent === undefined &&
      toolNameMatchesRule(rule.ruleValue.toolName, toolName, true),
  );
}

export class RuleStore {
  private readonly rules: PermissionRule[] = [];

  add(rule: PermissionRule): void {
    this.rules.push(rule);
  }

  addAll(rules: readonly PermissionRule[]): void {
    for (const r of rules) this.rules.push(r);
  }

  all(): readonly PermissionRule[] {
    return this.rules;
  }

  match(
    toolName: string,
    input: string,
    aliasNames: readonly string[] = [],
  ): PermissionBehavior | null {
    const matchesAny = (r: PermissionRule): boolean => {
      if (ruleMatches(r, toolName, input)) return true;
      if (!sourceSupportsAliasExpansion(r)) return false;
      return aliasNames.some((n) => ruleMatches(r, n, input));
    };
    if (this.rules.some((r) => r.ruleBehavior === "deny" && matchesAny(r))) return "deny";
    if (this.rules.some((r) => r.ruleBehavior === "ask" && matchesAny(r))) return "ask";
    if (this.rules.some((r) => r.ruleBehavior === "allow" && matchesAny(r))) return "allow";
    return null;
  }

  // Matches `field:pattern` rule content (e.g. `subagent_type:Explore`)
  // against the named scalar field of the structured tool input, so rules
  // that target a field other than the tool's primary content field (which
  // stays on its existing `match()` path) are still honored. Only deny/ask
  // are consulted here for input-param rule lookup.
  matchInputParam(
    toolName: string,
    input: unknown,
    primaryField: string | null,
    behavior: "deny" | "ask",
    aliasNames: readonly string[] = [],
  ): PermissionRule | null {
    if (!input || typeof input !== "object") return null;
    if (mcpInfoFromString(toolName) !== null) return null;
    const obj = input as Record<string, unknown>;
    for (const r of this.rules) {
      if (r.ruleBehavior !== behavior) continue;
      const namesToCheck = sourceSupportsAliasExpansion(r) ? [toolName, ...aliasNames] : [toolName];
      if (!namesToCheck.some((n) => toolNameMatchesRule(r.ruleValue.toolName, n, true))) continue;
      const parsed = parseInputParamRuleContent(r.ruleValue.ruleContent);
      if (!parsed) continue;
      if (parsed.field === primaryField) continue;
      if (!Object.hasOwn(obj, parsed.field)) continue;
      const value = obj[parsed.field];
      if (value === undefined || value === null || typeof value === "object") continue;
      if (matchesGlob(parsed.pattern, String(value).trim())) return r;
    }
    return null;
  }
}

export function isCompoundBashCommand(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed.includes("\n")) return true;
  if (/\$\(|`/.test(trimmed)) return true;
  const subs = splitBashSubcommands(trimmed).filter((s) => s.trim().length > 0);
  return subs.length > 1;
}

export function ruleMatches(rule: PermissionRule, toolName: string, input: string): boolean {
  if (!toolNameMatchesRule(rule.ruleValue.toolName, toolName, rule.ruleBehavior !== "allow"))
    return false;
  // Content-specific rules are ignored for MCP tools. Only server- and
  // tool-level MCP rules participate in permission matching.
  if (mcpInfoFromString(toolName) !== null && rule.ruleValue.ruleContent !== undefined)
    return false;
  if (!rule.ruleValue.ruleContent || rule.ruleValue.ruleContent.length === 0) return true;
  if (toolName === "WebFetch") {
    return webFetchRuleContentMatches(rule.ruleValue.ruleContent, input);
  }
  if (toolName === "Bash") {
    if (rule.ruleBehavior === "allow") {
      if (isCompoundForGuard(input)) return false;
      if (allowRuleCoversDangerousFind(input)) return false;
      if (containsUnsafeRedirect(input)) return false;
    }
    const normalized = normalizeBashCommand(input, rule.ruleBehavior);
    if (normalized !== input) {
      if (matchesPermissionInput(rule.ruleValue.ruleContent, normalized)) return true;
    }
  }
  return matchesPermissionInput(rule.ruleValue.ruleContent, input);
}

function mcpInfoFromString(
  toolName: string,
): { serverName: string; toolName: string | undefined } | null {
  const [prefix, serverName, ...toolNameParts] = toolName.split("__");
  if (prefix !== "mcp" || !serverName) return null;
  return {
    serverName,
    toolName: toolNameParts.length > 0 ? toolNameParts.join("__") : undefined,
  };
}

function toolNameMatchesRule(
  ruleToolName: string,
  toolName: string,
  globMatching = false,
): boolean {
  if (ruleToolName === toolName) return true;
  if (globMatching && ruleToolName.includes("*") && matchesGlob(ruleToolName, toolName))
    return true;
  const ruleInfo = mcpInfoFromString(ruleToolName);
  const toolInfo = mcpInfoFromString(toolName);
  return (
    ruleInfo !== null &&
    toolInfo !== null &&
    ruleInfo.serverName === toolInfo.serverName &&
    (ruleInfo.toolName === undefined ||
      ruleInfo.toolName === "*" ||
      (toolInfo.toolName !== undefined &&
        ruleInfo.toolName.includes("*") &&
        matchesGlob(ruleInfo.toolName, toolInfo.toolName)))
  );
}

function normalizeBashCommand(command: string, behavior: PermissionBehavior): string {
  const withoutHeredoc = stripHeredocBody(command);
  const tokens = withoutHeredoc.split(/\s+/).filter((t) => t.length > 0);
  const stripped =
    behavior === "allow"
      ? stripSafeWrappers(stripLeadingSafeEnvVars(tokens))
      : stripLeadingEnvAssignments(tokens);
  const xargs = looksLikeXargsCarrier(stripped);
  return (xargs ? xargs.remainder : stripped).join(" ");
}

export function permissionPatternMatches(pattern: string, toolName: string, input = ""): boolean {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return false;
  if (toolNameMatchesRule(trimmed, toolName)) return true;
  const split = splitToolInputPattern(trimmed);
  if (!split) return false;
  if (!toolNameMatchesRule(split.tool, toolName)) return false;
  if (split.input.length === 0) return true;
  if (toolName === "WebFetch") return webFetchRuleContentMatches(split.input, input);
  if (
    toolName === "Bash" &&
    (isCompoundBashCommand(input) ||
      allowRuleCoversDangerousFind(input) ||
      containsUnsafeRedirect(input))
  )
    return false;
  return matchesPermissionInput(split.input, input);
}

const PERMISSION_PREFIX_WRAPPERS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "env",
  "xargs",
  "sudo",
  "doas",
  "timeout",
  "nice",
  "ionice",
  "nohup",
  "command",
  "time",
  "watch",
  "setsid",
  "taskset",
  "chrt",
  "strace",
  "ltrace",
  "script",
  "flock",
  "unshare",
  "nsenter",
]);
const COMMAND_WORD = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function bashCommandPrefix(command: string): string | null {
  const tokens = command
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  let index = 0;
  while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index] as string)) index++;
  const first = tokens[index];
  if (!first || PERMISSION_PREFIX_WRAPPERS.has(first) || !COMMAND_WORD.test(first)) return null;
  const second = tokens[index + 1];
  if (second && COMMAND_WORD.test(second)) return `${first} ${second}`;
  return first;
}

export function permissionInputForCall(input: unknown, preview = ""): string {
  return permissionTargetFromInput(input) ?? preview;
}

export function permissionKeyForCall(toolName: string, input: unknown, preview = ""): string {
  if (toolName.startsWith("mcp__")) return toolName;
  if (toolName === "WebFetch") {
    return `${toolName}(${webFetchPermissionTarget(input)})`;
  }
  const target = permissionInputForCall(input, preview);
  if (toolName === "Bash" && target.length > 0) {
    const prefix = bashCommandPrefix(target);
    if (prefix) return `${toolName}(${prefix} *)`;
  }
  return target.length > 0 ? `${toolName}(${target})` : toolName;
}

function splitToolInputPattern(pattern: string): { tool: string; input: string } | null {
  const openIdx = pattern.indexOf("(");
  const closeIdx = pattern.lastIndexOf(")");
  if (openIdx >= 0 && closeIdx > openIdx) {
    const tool = pattern.slice(0, openIdx).trim();
    const input = pattern.slice(openIdx + 1, closeIdx).trim();
    return tool.length > 0 ? { tool, input } : null;
  }
  const idx = pattern.indexOf(":");
  if (idx < 0) return null;
  const tool = pattern.slice(0, idx).trim();
  const input = pattern.slice(idx + 1).trim();
  return tool.length > 0 ? { tool, input } : null;
}

const PERMISSION_TARGET_FIELDS = [
  "command",
  "file_path",
  "notebook_path",
  "path",
  "url",
  "query",
  "description",
] as const;

function permissionTargetFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  for (const key of PERMISSION_TARGET_FIELDS) {
    const value = obj[key];
    if (typeof value !== "string") continue;
    const normalized = value.replace(/\n/g, " ").trim();
    if (normalized.length > 0) return normalized;
  }
  try {
    const serialized = JSON.stringify(input);
    return serialized.length > 0 ? serialized : null;
  } catch {
    return null;
  }
}

// The field whose value `permissionTargetFromInput` selected as the primary
// match target for this call, if any. Field-specific `field:pattern` rules
// for that same field are left to the existing specialized path (via
// `RuleStore.match`) instead of being re-evaluated generically.
export function permissionTargetFieldFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  for (const key of PERMISSION_TARGET_FIELDS) {
    const value = obj[key];
    if (typeof value !== "string") continue;
    if (value.replace(/\n/g, " ").trim().length > 0) return key;
  }
  return null;
}

// Parses `field:pattern` rule content (e.g. `subagent_type:Explore`) used by
// input-param rules. Returns null for content that isn't a valid field:pattern
// pair (no colon, or an empty field/pattern).
function parseInputParamRuleContent(
  content: string | undefined,
): { field: string; pattern: string } | null {
  if (!content) return null;
  const sep = content.indexOf(":");
  if (sep <= 0) return null;
  const field = content.slice(0, sep).trim();
  const pattern = content.slice(sep + 1).trim();
  if (field.length === 0 || pattern.length === 0) return null;
  return { field, pattern };
}

function webFetchPermissionTarget(input: unknown): string {
  if (input && typeof input === "object") {
    const url = (input as Record<string, unknown>).url;
    if (typeof url === "string") {
      try {
        return `domain:${new URL(url).hostname}`;
      } catch {}
    }
  }
  return `input:${String(input)}`;
}

function normalizeDomainPattern(content: string): string {
  if (!content.startsWith("domain:")) return content;
  return `domain:${content
    .slice(7)
    .toLowerCase()
    .replace(/(?<=[^*.])\.+(?=(:\d+)?$)/, "")}`;
}

function escapeDomainPattern(pattern: string): string {
  return pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^.:]*");
}

function matchesDomainWildcard(pattern: string, target: string): boolean {
  if (!pattern.startsWith("domain:") || !target.startsWith("domain:")) return false;
  if (pattern === "domain:*") return true;
  const regexSource = pattern.startsWith("domain:*.")
    ? `^domain:(?:[^.:]+\\.)+${escapeDomainPattern(pattern.slice(9))}$`
    : `^domain:${escapeDomainPattern(pattern.slice(7))}$`;
  return new RegExp(regexSource, "i").test(target);
}

function webFetchRuleContentMatches(ruleContent: string, input: string): boolean {
  let target = "input:[object Object]";
  try {
    target = `domain:${new URL(input).hostname}`;
  } catch {}

  // Permission content is compared as generated only; legacy full-URL rules
  // intentionally receive no compatibility fallback.
  if (ruleContent === target) return true;
  const normalizedRule = normalizeDomainPattern(ruleContent);
  const normalizedTarget = normalizeDomainPattern(target);
  return normalizedRule.includes("*")
    ? matchesDomainWildcard(normalizedRule, normalizedTarget)
    : normalizedRule === normalizedTarget;
}

function matchesPermissionInput(pattern: string, input: string): boolean {
  if (matchesGlob(pattern, input)) return true;
  if (!pattern.endsWith("/*")) return false;
  const base = pattern.slice(0, -1);
  return input.startsWith(base);
}

function matchesGlob(pattern: string, value: string): boolean {
  const trimmedPattern = pattern.trim();
  if (trimmedPattern === "*") return true;
  let processed = "";
  let starCount = 0;
  let i = 0;
  while (i < trimmedPattern.length) {
    const ch = trimmedPattern[i];
    if (ch === "\\" && i + 1 < trimmedPattern.length) {
      const next = trimmedPattern[i + 1];
      if (next === "*") {
        processed += "\x00ESCAPED_STAR\x00";
        i += 2;
        continue;
      } else if (next === "\\") {
        processed += "\x00ESCAPED_BACKSLASH\x00";
        i += 2;
        continue;
      }
    }
    if (ch === "*") starCount++;
    processed += ch;
    i++;
  }
  if (starCount === 0) return trimmedPattern === value;
  const escaped = processed.replace(/[.+?^${}()|[\]\\'"]/g, "\\$&");
  let regexPattern = escaped
    .replace(/\*/g, ".*")
    .replaceAll("\x00ESCAPED_STAR\x00", "\\*")
    .replaceAll("\x00ESCAPED_BACKSLASH\x00", "\\\\");
  if (regexPattern.endsWith(" .*") && starCount === 1) {
    regexPattern = regexPattern.slice(0, -3) + "( .*)?";
  }
  return new RegExp(`^${regexPattern}$`, "s").test(value);
}
