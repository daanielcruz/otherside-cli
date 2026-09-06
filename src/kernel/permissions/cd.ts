import { homedir } from "node:os";
import { relative, sep } from "node:path";
import { loadRulesSync } from "@/kernel/permissions/persist.ts";
import type { PermissionRule, RuleSourceScope } from "@/kernel/permissions/types.ts";
import { serializeRuleValue } from "@/kernel/permissions/types.ts";
import { canonicalizeCwd } from "@/kernel/std/fs/paths.ts";

const CD_TOOL_IDENTITY = "Cd";
const DIRECTORY_WILDCARD_TOKEN = /^\*\*\/|\/\*\*|\*\*|\*|[\\^$.|?+()[\]{}]/g;

const RULE_SOURCE_DESCRIPTIONS: Record<RuleSourceScope, string> = {
  userSettings: "user settings",
  projectSettings: "shared project settings",
  localSettings: "project local settings",
  flagSettings: "command line arguments",
  policySettings: "enterprise managed settings",
  cliArg: "CLI argument",
  command: "command configuration",
  session: "current session",
  toolsNarrowing: "tool narrowing",
};

export type CdPermissionOutcome =
  | { result: "allowed" }
  | { result: "blockedByRule"; rule: PermissionRule }
  | { result: "outsideAllowedPatterns"; allowedPatterns: string[] };

function sourceDescription(ruleSource: RuleSourceScope): string {
  return RULE_SOURCE_DESCRIPTIONS[ruleSource] ?? ruleSource;
}

function wildcardReplacement(wildcardToken: string): string {
  switch (wildcardToken) {
    case "**/":
      return "(?:.*/)?";
    case "/**":
      return "(/.*)?";
    case "**":
      return ".*";
    case "*":
      return "[^/]+";
    default:
      return `\\${wildcardToken}`;
  }
}

function buildDirectoryMatcher(ruleText: string): RegExp {
  let regexpBody = "";
  let copiedThrough = 0;
  for (const wildcardToken of ruleText.matchAll(DIRECTORY_WILDCARD_TOKEN)) {
    const tokenOffset = wildcardToken.index;
    regexpBody += ruleText.slice(copiedThrough, tokenOffset);
    regexpBody += wildcardReplacement(wildcardToken[0]);
    copiedThrough = tokenOffset + wildcardToken[0].length;
  }
  regexpBody += ruleText.slice(copiedThrough);
  return new RegExp(`^${regexpBody}$`, "i");
}

function slashRelativePath(originDirectory: string, destinationDirectory: string): string {
  return relative(originDirectory, destinationDirectory).split(sep).join("/");
}

function resolveHomeRule(ruleText: string): string {
  if (ruleText === "~") return homedir();
  return ruleText.startsWith("~/") ? `${homedir()}${ruleText.slice(1)}` : ruleText;
}

function collapseRuleSlashes(pathText: string): string {
  return pathText.replace(/\/{2,}/g, "/").replace(/\/$/, "");
}

function withoutInitialSlash(pathText: string): string {
  return pathText.replace(/^\//, "");
}

function rootedRuleCovers(ruleText: string, destinationPath: string): boolean {
  const comparableRule = collapseRuleSlashes(resolveHomeRule(ruleText));
  const comparableDestination = collapseRuleSlashes(destinationPath);
  if (buildDirectoryMatcher(comparableRule).test(comparableDestination)) return true;
  return buildDirectoryMatcher(withoutInitialSlash(comparableRule)).test(
    withoutInitialSlash(comparableDestination),
  );
}

function relativeRuleCovers(
  ruleText: string,
  destinationPath: string,
  anchoredCwd: string,
): boolean {
  const cwdRelativePath = slashRelativePath(anchoredCwd, destinationPath);
  if (cwdRelativePath === ".." || cwdRelativePath.startsWith("../")) return false;
  const comparableRule = withoutInitialSlash(collapseRuleSlashes(ruleText));
  return buildDirectoryMatcher(comparableRule).test(cwdRelativePath);
}

function directoryRuleCovers(
  ruleText: string,
  destinationPath: string,
  anchoredCwd: string,
): boolean {
  const cleanedRule = ruleText.trim();
  if (cleanedRule.length === 0) return true;
  const isRootedRule =
    cleanedRule.startsWith("/") || cleanedRule === "~" || cleanedRule.startsWith("~/");
  return isRootedRule
    ? rootedRuleCovers(cleanedRule, destinationPath)
    : relativeRuleCovers(cleanedRule, destinationPath, anchoredCwd);
}

function ruleCoversDestination(
  rule: PermissionRule,
  destinationPaths: readonly string[],
  anchoredCwd: string,
): boolean {
  const ruleText = rule.ruleValue.ruleContent;
  return (
    ruleText === undefined ||
    destinationPaths.some((destinationPath) =>
      directoryRuleCovers(ruleText, destinationPath, anchoredCwd),
    )
  );
}

function isCdRuleWithBehavior(rule: PermissionRule, ruleBehavior: "allow" | "deny"): boolean {
  return rule.ruleBehavior === ruleBehavior && rule.ruleValue.toolName === CD_TOOL_IDENTITY;
}

export function evaluateCdPermission(
  target: { requestedPath: string; canonicalPath: string },
  opts: { rules?: readonly PermissionRule[]; baseCwd: string },
): CdPermissionOutcome {
  const configuredRules = opts.rules ?? loadRulesSync(opts.baseCwd);
  const anchoredCwd = canonicalizeCwd(opts.baseCwd);
  const denialDestinations = [...new Set([target.requestedPath, target.canonicalPath])];
  const blockingRule = configuredRules.find(
    (rule) =>
      isCdRuleWithBehavior(rule, "deny") &&
      ruleCoversDestination(rule, denialDestinations, anchoredCwd),
  );
  if (blockingRule !== undefined) return { result: "blockedByRule", rule: blockingRule };

  const permissionGrants = configuredRules.filter((rule) => isCdRuleWithBehavior(rule, "allow"));
  if (permissionGrants.length === 0) return { result: "allowed" };

  const canonicalDestination = [target.canonicalPath];
  if (
    permissionGrants.some((rule) => ruleCoversDestination(rule, canonicalDestination, anchoredCwd))
  ) {
    return { result: "allowed" };
  }

  return {
    result: "outsideAllowedPatterns",
    allowedPatterns: permissionGrants.flatMap((rule) => {
      const ruleText = rule.ruleValue.ruleContent;
      return ruleText === undefined ? [] : [ruleText];
    }),
  };
}

export function cdRuleDenialMessage(
  dir: string,
  permissionResult: Exclude<CdPermissionOutcome, { result: "allowed" }>,
  format: (value: string) => string = (value) => value,
): string {
  if (permissionResult.result === "blockedByRule") {
    const blockedRuleName = serializeRuleValue(permissionResult.rule.ruleValue);
    const blockedRuleSource = sourceDescription(permissionResult.rule.source);
    if (permissionResult.rule.ruleValue.ruleContent === undefined) {
      return `Can't move to ${format(dir)} — /cd is turned off by the ${format(blockedRuleName)} rule in ${blockedRuleSource}. Update the rule in /permissions to move between directories again.`;
    }
    return `Can't move to ${format(dir)} — it's excluded by the ${format(blockedRuleName)} rule in ${blockedRuleSource}. Pick a directory outside that rule, or update it in /permissions.`;
  }
  return `Can't move to ${format(dir)} — /cd is limited to directories matching ${permissionResult.allowedPatterns.map((allowedPattern) => format(allowedPattern)).join(", ")}. Pick a matching directory, or add a Cd rule in /permissions.`;
}
