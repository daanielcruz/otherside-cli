import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuleStore } from "@/kernel/permissions/index.ts";
import {
  isManagedPermissionRulesOnly,
  loadRulesSync,
  saveRules,
} from "@/kernel/permissions/persist.ts";

const TMP = mkdtempSync(join(tmpdir(), "permissions-persist-"));
const USER_DIR = join(TMP, "user");
const CWD = join(TMP, "cwd");

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(USER_DIR, { recursive: true });
  mkdirSync(join(CWD, ".otherside"), { recursive: true });
  process.env.OTHERSIDE_CONFIG_DIR = USER_DIR;
});

afterEach(() => {
  delete process.env.OTHERSIDE_CONFIG_DIR;
  rmSync(TMP, { recursive: true, force: true });
});

describe("isManagedPermissionRulesOnly", () => {
  test("false when no managed settings file sets the flag", () => {
    expect(isManagedPermissionRulesOnly()).toBe(false);
  });

  test("true when managed-settings.json sets allowManagedPermissionRulesOnly", () => {
    writeJson(join(USER_DIR, "managed-settings.json"), {
      allowManagedPermissionRulesOnly: true,
    });
    expect(isManagedPermissionRulesOnly()).toBe(true);
  });
});

describe("loadRulesSync managed-only policy", () => {
  test("user allow rule bypasses nothing when policy is absent (baseline)", () => {
    writeJson(join(USER_DIR, "settings.json"), {
      permissions: { allow: ["Bash(echo *)"] },
    });

    const rules = loadRulesSync();
    expect(rules.some((r) => r.source === "userSettings")).toBe(true);
  });

  test("managed-only policy hides the user allow rule (PERM-001 regression)", () => {
    writeJson(join(USER_DIR, "managed-settings.json"), {
      allowManagedPermissionRulesOnly: true,
      permissions: { deny: ["Bash(rm -rf *)"] },
    });
    writeJson(join(USER_DIR, "settings.json"), {
      permissions: { allow: ["Bash(echo *)"] },
    });

    const rules = loadRulesSync();

    // Only policySettings-sourced rules are loaded; the userSettings
    // Bash(echo *) allow must not leak through and bypass managed policy.
    expect(rules.every((r) => r.source === "policySettings")).toBe(true);
    expect(rules.some((r) => r.source === "userSettings")).toBe(false);

    const store = new RuleStore();
    store.addAll(rules);
    // echo is not allow-listed by policy, so it is not
    // silently permitted merely because the (now-ignored) user settings
    // would have allowed it.
    expect(store.match("Bash", "echo hi")).toBe(null);
  });

  test("managed-only policy preserves its own deny/ask precedence over allow", () => {
    writeJson(join(USER_DIR, "managed-settings.json"), {
      allowManagedPermissionRulesOnly: true,
      permissions: {
        allow: ["Bash(*)"],
        deny: ["Bash(rm -rf *)"],
        ask: ["Bash(git push*)"],
      },
    });

    const rules = loadRulesSync();
    const store = new RuleStore();
    store.addAll(rules);

    // deny beats the broad policy allow
    expect(store.match("Bash", "rm -rf /")).toBe("deny");
    // ask beats the broad policy allow
    expect(store.match("Bash", "git push origin main")).toBe("ask");
    // anything else still falls through to the policy allow
    expect(store.match("Bash", "ls -la")).toBe("allow");
  });

  test("managed-only policy blocks persisting new allow rules via saveRules", async () => {
    writeJson(join(USER_DIR, "managed-settings.json"), {
      allowManagedPermissionRulesOnly: true,
    });

    const before = loadRulesSync(CWD);
    await saveRules(
      [
        ...before,
        {
          source: "userSettings",
          ruleBehavior: "allow",
          ruleValue: { toolName: "Bash", ruleContent: "echo *" },
        },
      ],
      CWD,
    );

    expect(existsSync(join(USER_DIR, "settings.json"))).toBe(false);
    expect(existsSync(join(CWD, ".otherside", "settings.json"))).toBe(false);
    expect(existsSync(join(CWD, ".otherside", "settings.local.json"))).toBe(false);

    const after = loadRulesSync(CWD);
    expect(after.some((r) => r.source === "userSettings")).toBe(false);
  });

  test("without managed-only, saveRules persists new allow rules as before", async () => {
    const before = loadRulesSync(CWD);
    await saveRules(
      [
        ...before,
        {
          source: "userSettings",
          ruleBehavior: "allow",
          ruleValue: { toolName: "Bash", ruleContent: "echo *" },
        },
      ],
      CWD,
    );

    const written = JSON.parse(readFileSync(join(USER_DIR, "settings.json"), "utf8"));
    expect(written.permissions.allow).toContain("Bash(echo *)");
  });
});
