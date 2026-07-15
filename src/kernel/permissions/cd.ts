import { homedir } from "node:os";
import { relative, sep } from "node:path";
import { loadRulesSync } from "@/kernel/permissions/persist.ts";
import type { PermissionRule, PermissionRuleSource } from "@/kernel/permissions/types.ts";
import { permissionRuleValueToString } from "@/kernel/permissions/types.ts";
import { canonicalizeCwd } from "@/kernel/std/fs/paths.ts";

const CD_PERMISSION_TOOL_NAME = "Cd";

export type CdPermissionResult =
  | { result: "allowed" }
  | { result: "blockedByRule"; rule: PermissionRule }
  | { result: "outsideAllowedPatterns"; allowedPatterns: string[] };

function permissionRuleSourceDisplayString(source: PermissionRuleSource): string {
  switch (source) {
    case "userSettings":
      return "user settings";
    case "projectSettings":
      return "shared project settings";
    case "localSettings":
      return "project local settings";
    case "flagSettings":
      return "command line arguments";
    case "policySettings":
      return "enterprise managed settings";
    case "cliArg":
      return "CLI argument";
    case "command":
      return "command configuration";
    case "session":
      return "current session";
    case "toolsNarrowing":
      return "tool narrowing";
    default:
      return source;
  }
}

function cdRulePatternToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? "";
    if (i === 0 && ch === "*" && pattern[i + 1] === "*" && pattern[i + 2] === "/") {
      out += "(?:.*/)?";
      i += 2;
    } else if (ch === "/" && pattern[i + 1] === "*" && pattern[i + 2] === "*") {
      out += "(/.*)?";
      i += 2;
    } else if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]+";
      }
    } else if ("\\^$.|?+()[]{}".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`${out}$`, "i");
}

function posixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

function expandHomePattern(pattern: string): string {
  if (pattern === "~") return homedir();
  if (pattern.startsWith("~/")) return `${homedir()}${pattern.slice(1)}`;
  return pattern;
}

function cdPatternMatches(pattern: string, candidate: string, baseCwd: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.startsWith("/") || trimmed.startsWith("~/") || trimmed === "~") {
    const expanded = expandHomePattern(trimmed);
    const normalizedPattern = expanded.replace(/\/{2,}/g, "/").replace(/\/$/, "");
    const normalizedCandidate = candidate.replace(/\/{2,}/g, "/").replace(/\/$/, "");
    if (cdRulePatternToRegExp(normalizedPattern).test(normalizedCandidate)) return true;
    // Also try without a leading slash on both sides for root-relative absolute patterns.
    return cdRulePatternToRegExp(normalizedPattern.replace(/^\//, "")).test(
      normalizedCandidate.replace(/^\//, ""),
    );
  }
  const rel = posixRelative(baseCwd, candidate);
  if (rel === ".." || rel.startsWith("../")) return false;
  const normalizedPattern = trimmed
    .replace(/\/{2,}/g, "/")
    .replace(/^\//, "")
    .replace(/\/$/, "");
  return cdRulePatternToRegExp(normalizedPattern).test(rel);
}

export function checkCdPermission(
  target: { requestedPath: string; canonicalPath: string },
  opts: { rules?: readonly PermissionRule[]; baseCwd: string },
): CdPermissionResult {
  const rules = opts.rules ?? loadRulesSync(opts.baseCwd);
  const baseCwd = canonicalizeCwd(opts.baseCwd);
  const denyPaths = [...new Set([target.requestedPath, target.canonicalPath])];
  const allowPaths = [...new Set([target.canonicalPath])];

  const matchesAny = (pattern: string, paths: string[]) =>
    paths.some((path) => cdPatternMatches(pattern, path, baseCwd));

  for (const rule of rules) {
    if (rule.ruleBehavior !== "deny") continue;
    if (rule.ruleValue.toolName !== CD_PERMISSION_TOOL_NAME) continue;
    const pattern = rule.ruleValue.ruleContent;
    if (pattern === undefined || matchesAny(pattern, denyPaths)) {
      return { result: "blockedByRule", rule };
    }
  }

  const allowRules = rules.filter(
    (rule) => rule.ruleBehavior === "allow" && rule.ruleValue.toolName === CD_PERMISSION_TOOL_NAME,
  );
  if (allowRules.length === 0) return { result: "allowed" };

  for (const rule of allowRules) {
    const pattern = rule.ruleValue.ruleContent;
    if (pattern === undefined || matchesAny(pattern, allowPaths)) {
      return { result: "allowed" };
    }
  }

  return {
    result: "outsideAllowedPatterns",
    allowedPatterns: allowRules
      .map((rule) => rule.ruleValue.ruleContent)
      .filter((pattern): pattern is string => pattern !== undefined),
  };
}

export function cdRuleRefusalMessage(
  dir: string,
  permissionResult: Exclude<CdPermissionResult, { result: "allowed" }>,
  format: (value: string) => string = (value) => value,
): string {
  if (permissionResult.result === "blockedByRule") {
    const ruleName = permissionRuleValueToString(permissionResult.rule.ruleValue);
    const sourceStr = permissionRuleSourceDisplayString(permissionResult.rule.source);
    if (permissionResult.rule.ruleValue.ruleContent === undefined) {
      return `Can't move to ${format(dir)} — /cd is turned off by the ${format(ruleName)} rule in ${sourceStr}. Update the rule in /permissions to move between directories again.`;
    }
    return `Can't move to ${format(dir)} — it's excluded by the ${format(ruleName)} rule in ${sourceStr}. Pick a directory outside that rule, or update it in /permissions.`;
  }
  return `Can't move to ${format(dir)} — /cd is limited to directories matching ${permissionResult.allowedPatterns.map((pattern) => format(pattern)).join(", ")}. Pick a matching directory, or add a Cd rule in /permissions.`;
}
