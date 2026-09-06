import { describe, expect, it } from "bun:test";
import { cdRuleDenialMessage, evaluateCdPermission } from "@/kernel/permissions/cd.ts";
import type {
  PermissionBehavior,
  PermissionRule,
  RuleSourceScope,
} from "@/kernel/permissions/types.ts";

const WORKSPACE = "/placeholder/workspace";

type RuleOptions = {
  behavior?: PermissionBehavior;
  content?: string;
  source?: RuleSourceScope;
  toolName?: string;
};

function makeRule({
  behavior = "allow",
  content,
  source = "userSettings",
  toolName = "Cd",
}: RuleOptions = {}): PermissionRule {
  return {
    source,
    ruleBehavior: behavior,
    ruleValue: content === undefined ? { toolName } : { toolName, ruleContent: content },
  };
}

function evaluate(
  destination: string,
  rules: readonly PermissionRule[],
  requestedPath = destination,
) {
  return evaluateCdPermission(
    { requestedPath, canonicalPath: destination },
    { rules, baseCwd: WORKSPACE },
  );
}

describe("evaluateCdPermission", () => {
  it("fails open when no Cd allow or deny rules exist", () => {
    expect(evaluate(`${WORKSPACE}/pkg`, [])).toEqual({ result: "allowed" });
    expect(evaluate(`${WORKSPACE}/pkg`, [makeRule({ behavior: "ask" })])).toEqual({
      result: "allowed",
    });
    expect(
      evaluate(`${WORKSPACE}/pkg`, [makeRule({ behavior: "deny", toolName: "Read" })]),
    ).toEqual({ result: "allowed" });
  });

  it("blocks a whole-tool deny and reports its exact rule object", () => {
    const denyRule = makeRule({ behavior: "deny" });
    const decision = evaluate(`${WORKSPACE}/pkg`, [denyRule]);

    expect(decision).toEqual({ result: "blockedByRule", rule: denyRule });
    if (decision.result !== "blockedByRule") throw new Error("expected a blocked decision");
    expect(decision.rule).toBe(denyRule);
    expect(cdRuleDenialMessage(`${WORKSPACE}/pkg`, decision)).toBe(
      `Can't move to ${WORKSPACE}/pkg — /cd is turned off by the Cd rule in user settings. Update the rule in /permissions to move between directories again.`,
    );
  });

  it("evaluates every deny before any allow", () => {
    const allowRule = makeRule({ content: "pkg/**" });
    const denyRule = makeRule({
      behavior: "deny",
      content: "pkg/**",
      source: "policySettings",
    });

    expect(evaluate(`${WORKSPACE}/pkg/nested`, [allowRule, denyRule])).toEqual({
      result: "blockedByRule",
      rule: denyRule,
    });
  });

  it("returns the first matching deny in configured order", () => {
    const firstMiss = makeRule({ behavior: "deny", content: "other/**" });
    const firstMatch = makeRule({
      behavior: "deny",
      content: "pkg/**",
      source: "session",
    });
    const laterMatch = makeRule({
      behavior: "deny",
      content: "pkg/nested",
      source: "policySettings",
    });

    expect(evaluate(`${WORKSPACE}/pkg/nested`, [firstMiss, firstMatch, laterMatch])).toEqual({
      result: "blockedByRule",
      rule: firstMatch,
    });
  });

  it("checks both requested and canonical paths for deny rules", () => {
    const requestedRule = makeRule({ behavior: "deny", content: "link" });
    const canonicalRule = makeRule({ behavior: "deny", content: "real" });

    expect(evaluate(`${WORKSPACE}/real`, [requestedRule], `${WORKSPACE}/link`)).toEqual({
      result: "blockedByRule",
      rule: requestedRule,
    });
    expect(evaluate(`${WORKSPACE}/real`, [canonicalRule], `${WORKSPACE}/link`)).toEqual({
      result: "blockedByRule",
      rule: canonicalRule,
    });
  });

  it("checks only the canonical path for allow rules", () => {
    const requestedOnly = makeRule({ content: "link" });
    const canonical = makeRule({ content: "real" });

    expect(evaluate(`${WORKSPACE}/real`, [requestedOnly], `${WORKSPACE}/link`)).toEqual({
      result: "outsideAllowedPatterns",
      allowedPatterns: ["link"],
    });
    expect(evaluate(`${WORKSPACE}/real`, [canonical], `${WORKSPACE}/link`)).toEqual({
      result: "allowed",
    });
  });

  it("enforces an allowlist and preserves pattern order in a rejection", () => {
    const firstRule = makeRule({ content: "first/**" });
    const wholeToolRule = makeRule();
    const lastRule = makeRule({ content: "last/**" });

    expect(evaluate(`${WORKSPACE}/other`, [firstRule, wholeToolRule, lastRule])).toEqual({
      result: "allowed",
    });
    expect(evaluate(`${WORKSPACE}/other`, [firstRule, lastRule])).toEqual({
      result: "outsideAllowedPatterns",
      allowedPatterns: ["first/**", "last/**"],
    });
  });

  it.each([
    ["pkg", `${WORKSPACE}/pkg`, true],
    ["pkg", `${WORKSPACE}/pkg/nested`, false],
    ["pkg/*", `${WORKSPACE}/pkg/child`, true],
    ["pkg/*", `${WORKSPACE}/pkg/nested/child`, false],
    ["pkg/**", `${WORKSPACE}/pkg`, true],
    ["pkg/**", `${WORKSPACE}/pkg/nested/child`, true],
    ["**/child", `${WORKSPACE}/child`, true],
    ["**/child", `${WORKSPACE}/pkg/nested/child`, true],
    ["pkg/**/child", `${WORKSPACE}/pkg/child`, true],
    ["pkg/**/child", `${WORKSPACE}/pkg/nested/child`, true],
    ["pkg?", `${WORKSPACE}/pkg?`, true],
    ["pkg?", `${WORKSPACE}/pkga`, false],
    ["a+b[1](x).$", `${WORKSPACE}/a+b[1](x).$`, true],
    ["ärea/**", `${WORKSPACE}/ÄREA/child`, true],
  ])("matches the frozen wildcard language: %s against %s", (content, destination, allowed) => {
    const decision = evaluate(destination, [makeRule({ content })]);
    expect(decision.result === "allowed").toBe(allowed);
  });

  it("collapses repeated forward slashes and ignores one trailing slash", () => {
    expect(evaluate(`${WORKSPACE}//pkg///nested/`, [makeRule({ content: "pkg///**/" })])).toEqual({
      result: "allowed",
    });
  });

  it("treats empty and whitespace-only patterns as matching every destination", () => {
    expect(evaluate(`${WORKSPACE}/outside`, [makeRule({ content: "" })])).toEqual({
      result: "allowed",
    });
    expect(evaluate(`${WORKSPACE}/outside`, [makeRule({ content: "   " })])).toEqual({
      result: "allowed",
    });
  });

  it("does not let a relative rule reach outside the anchored cwd", () => {
    expect(evaluate("/placeholder/outside/pkg", [makeRule({ content: "**" })])).toEqual({
      result: "outsideAllowedPatterns",
      allowedPatterns: ["**"],
    });
  });

  it("keeps backslashes literal on POSIX", () => {
    expect(evaluate(`${WORKSPACE}/C:/pkg`, [makeRule({ content: "C:\\*" })])).toEqual({
      result: "outsideAllowedPatterns",
      allowedPatterns: ["C:\\*"],
    });
  });
});

describe("cdRuleDenialMessage", () => {
  it("renders an exact patterned-deny message with formatting", () => {
    const denyRule = makeRule({
      behavior: "deny",
      content: "private/**",
      source: "cliArg",
    });
    const decision = evaluate(`${WORKSPACE}/private/keys`, [denyRule]);
    if (decision.result !== "blockedByRule") throw new Error("expected a blocked decision");

    expect(cdRuleDenialMessage(`${WORKSPACE}/private/keys`, decision, (text) => `<${text}>`)).toBe(
      `Can't move to <${WORKSPACE}/private/keys> — it's excluded by the <Cd(private/**)> rule in CLI argument. Pick a directory outside that rule, or update it in /permissions.`,
    );
  });

  it("renders the exact allowlist rejection message", () => {
    const decision = evaluate(`${WORKSPACE}/other`, [
      makeRule({ content: "packages/**" }),
      makeRule({ content: "examples/*" }),
    ]);
    if (decision.result !== "outsideAllowedPatterns") {
      throw new Error("expected an allowlist rejection");
    }

    expect(cdRuleDenialMessage(`${WORKSPACE}/other`, decision)).toBe(
      `Can't move to ${WORKSPACE}/other — /cd is limited to directories matching packages/**, examples/*. Pick a matching directory, or add a Cd rule in /permissions.`,
    );
  });
});
