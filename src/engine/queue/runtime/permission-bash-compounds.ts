import { containsUnsafeRedirect } from "@/kernel/permissions/bash-matcher.ts";
import { splitBashSubcommands } from "@/kernel/permissions/sensitive-paths.ts";
import type { PermissionBehavior } from "@/kernel/permissions/types.ts";
import { bashWritePaths } from "./permission-bash-paths.ts";

const MAX_COMPOUND_BASH_SEGMENTS = 50;

export interface CompoundBashProbes {
  matchSub: (sub: string) => PermissionBehavior | null;
  subSessionAllowed: (sub: string) => boolean;
  subAutoAllowed: (sub: string) => boolean;
}

// Single-rule matchers refuse compound commands outright (a `sleep *` allow
// must not bless `sleep 1 && rm -rf /`), so compounds are decided here by
// evaluating EVERY chained segment on its own: any denied segment denies the
// call, an explicit ask-rule forces the prompt, and the call is auto-allowed
// only when each segment is individually allowed (rule, session grant, or
// read-only). Substitution/newline commands stay un-splittable → prompt.
export function compoundBashDecision(
  command: string,
  probes: CompoundBashProbes,
): "allow" | "deny" | "ask" | "rule-ask" | null {
  if (command.includes("\n") || /\$\(|`/.test(command)) return null;
  const segments = splitBashSubcommands(command)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length <= 1) return null;
  if (segments.length > MAX_COMPOUND_BASH_SEGMENTS) return "ask";
  const cdCount = segments.filter((segment) => /^cd(?:\s|$)/.test(segment)).length;
  if (cdCount > 1) return "ask";
  if (cdCount === 1 && segments.some((segment) => bashWritePaths(segment) !== null)) return "ask";
  if (cdCount === 1 && segments.some((segment) => /^git(?:\s|$)/.test(segment))) return "ask";
  let allAllowed = true;
  for (const segment of segments) {
    const matched = probes.matchSub(segment);
    if (matched === "deny") return "deny";
    if (matched === "ask") return "rule-ask";
    if (matched === "allow" || probes.subSessionAllowed(segment)) continue;
    if (!containsUnsafeRedirect(segment) && probes.subAutoAllowed(segment)) continue;
    allAllowed = false;
  }
  return allAllowed ? "allow" : null;
}
