import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedPolicyError, resolveConfig } from "@/kernel/config/resolver.ts";

let root = "";
let userDirectory = "";
let projectDirectory = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "otherside-config-scopes-"));
  userDirectory = join(root, "user");
  projectDirectory = join(root, "project");
  mkdirSync(userDirectory, { recursive: true });
  mkdirSync(join(projectDirectory, ".otherside"), { recursive: true });
  mkdirSync(join(root, "policy"), { recursive: true });
  process.env.OTHERSIDE_CONFIG_DIR = userDirectory;
  process.env.OTHERSIDE_POLICY_DIR = join(root, "policy");
});

afterEach(() => {
  delete process.env.OTHERSIDE_CONFIG_DIR;
  delete process.env.OTHERSIDE_POLICY_DIR;
  rmSync(root, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

function expectPolicyFailure(
  action: () => void,
  code: ManagedPolicyError["code"],
  path: string,
): void {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(ManagedPolicyError);
  if (!(failure instanceof ManagedPolicyError)) return;
  expect(failure.code).toBe(code);
  expect(failure.path).toBe(path);
  expect(failure.message).toContain("Repair or remove");
}

test("enabledPlugins overrides individual keys across every scope", () => {
  writeJson(join(userDirectory, "settings.json"), {
    enabledPlugins: {
      "formatter@official": false,
      "user-only@official": true,
    },
  });
  writeJson(join(projectDirectory, ".otherside", "settings.json"), {
    enabledPlugins: {
      "formatter@official": true,
      "project-only@official": false,
    },
  });
  writeJson(join(projectDirectory, ".otherside", "settings.local.json"), {
    enabledPlugins: {
      "formatter@official": false,
      "local-only@official": true,
    },
  });
  writeJson(join(userDirectory, "managed-settings.json"), {
    enabledPlugins: {
      "formatter@official": true,
      "project-only@official": true,
    },
  });

  expect(
    resolveConfig(projectDirectory, {
      enabledPlugins: {
        "formatter@official": false,
        "session-only@official": true,
      },
    }).enabledPlugins,
  ).toEqual({
    "formatter@official": true,
    "user-only@official": true,
    "project-only@official": true,
    "local-only@official": true,
    "session-only@official": true,
  });
});

test("managed policy layers retain keys with deterministic user then system precedence", () => {
  const userDropDirectory = join(userDirectory, "managed-settings.d");
  const systemDropDirectory = join(root, "policy", "managed-settings.d");
  mkdirSync(userDropDirectory);
  mkdirSync(systemDropDirectory);

  writeJson(join(userDirectory, "managed-settings.json"), {
    enabledPlugins: {
      "managed-base@official": false,
      "shared@official": false,
    },
  });
  writeJson(join(userDropDirectory, "10-user.json"), {
    enabledPlugins: {
      "user-dropin@official": true,
      "shared@official": true,
    },
  });
  writeJson(join(userDropDirectory, "20-user.json"), {
    enabledPlugins: {
      "user-later@official": false,
      "shared@official": false,
    },
  });
  writeJson(join(root, "policy", "managed-settings.json"), {
    enabledPlugins: {
      "system-base@official": true,
      "shared@official": true,
    },
  });
  writeJson(join(systemDropDirectory, "10-system.json"), {
    enabledPlugins: {
      "system-dropin@official": false,
      "shared@official": false,
    },
  });
  writeJson(join(systemDropDirectory, "20-system.json"), {
    enabledPlugins: {
      "system-later@official": true,
      "shared@official": true,
    },
  });

  const enabledPlugins = resolveConfig(projectDirectory).enabledPlugins;
  expect(enabledPlugins).toEqual({
    "managed-base@official": false,
    "shared@official": true,
    "user-dropin@official": true,
    "user-later@official": false,
    "system-base@official": true,
    "system-dropin@official": false,
    "system-later@official": true,
  });
  expect(Object.keys(enabledPlugins ?? {})).toEqual([
    "managed-base@official",
    "shared@official",
    "user-dropin@official",
    "user-later@official",
    "system-base@official",
    "system-dropin@official",
    "system-later@official",
  ]);
});

test("malformed managed policy fails closed with an actionable typed error", () => {
  const policyPath = join(userDirectory, "managed-settings.json");
  writeFileSync(policyPath, '{"enabledPlugins":');

  expectPolicyFailure(() => resolveConfig(projectDirectory), "invalid-policy", policyPath);
});

test("unreadable managed policy fails closed with an actionable typed error", () => {
  const policyPath = join(root, "policy", "managed-settings.json");
  mkdirSync(policyPath);

  expectPolicyFailure(() => resolveConfig(projectDirectory), "unreadable", policyPath);
});

test("invalid managed enabledPlugins fails closed instead of using editable settings", () => {
  const policyPath = join(root, "policy", "managed-settings.json");
  writeJson(policyPath, {
    enabledPlugins: {
      "managed@official": "enabled",
    },
  });
  writeJson(join(userDirectory, "settings.json"), {
    enabledPlugins: { "editable@official": true },
  });

  expectPolicyFailure(() => resolveConfig(projectDirectory), "invalid-enabled-plugins", policyPath);
});

test("project settings accept enabledPlugins without affecting unrelated settings", () => {
  writeJson(join(projectDirectory, ".otherside", "settings.json"), {
    enabledPlugins: { "formatter@official": false },
  });

  const resolved = resolveConfig(projectDirectory);
  expect(resolved.enabledPlugins).toEqual({ "formatter@official": false });
  expect(resolved.defaultProvider).toBe("anthropic");
});
