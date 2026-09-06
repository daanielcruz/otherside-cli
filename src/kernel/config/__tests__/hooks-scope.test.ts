import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "@/kernel/config/resolver.ts";
import { projectSettingsPath } from "@/kernel/config/scope.ts";

const TMP = mkdtempSync(join(tmpdir(), "hooks-scope-"));
const USER_DIR = join(TMP, "user");
const CWD = join(TMP, "cwd");

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(USER_DIR, { recursive: true });
  mkdirSync(join(CWD, ".otherside"), { recursive: true });
  mkdirSync(join(TMP, "policy"), { recursive: true });
  process.env.OTHERSIDE_CONFIG_DIR = USER_DIR;
  process.env.OTHERSIDE_POLICY_DIR = join(TMP, "policy");
});

afterEach(() => {
  delete process.env.OTHERSIDE_CONFIG_DIR;
  delete process.env.OTHERSIDE_POLICY_DIR;
  rmSync(TMP, { recursive: true, force: true });
});

describe("project-scope hooks", () => {
  test("project hooks append to the user hooks for the same event, user first", () => {
    writeJson(join(USER_DIR, "settings.json"), {
      hooks: { preToolUse: [{ matcher: "Bash", command: "user-hook" }] },
    });
    writeJson(projectSettingsPath(CWD, "project"), {
      hooks: { preToolUse: [{ matcher: "Bash", command: "project-hook" }] },
    });

    expect(resolveConfig(CWD).hooks?.preToolUse).toEqual([
      { matcher: "Bash", command: "user-hook" },
      { matcher: "Bash", command: "project-hook" },
    ]);
  });

  test("an event only the project defines is added without disturbing user-only events", () => {
    writeJson(join(USER_DIR, "settings.json"), {
      hooks: { stop: [{ matcher: "*", command: "user-stop" }] },
    });
    writeJson(projectSettingsPath(CWD, "project"), {
      hooks: { sessionStart: [{ matcher: "*", command: "project-start" }] },
    });

    const hooks = resolveConfig(CWD).hooks;

    expect(hooks?.stop).toEqual([{ matcher: "*", command: "user-stop" }]);
    expect(hooks?.sessionStart).toEqual([{ matcher: "*", command: "project-start" }]);
  });

  test("local settings append after project, which append after user", () => {
    writeJson(join(USER_DIR, "settings.json"), {
      hooks: { stop: [{ matcher: "*", command: "user-stop" }] },
    });
    writeJson(projectSettingsPath(CWD, "project"), {
      hooks: { stop: [{ matcher: "*", command: "project-stop" }] },
    });
    writeJson(projectSettingsPath(CWD, "local"), {
      hooks: { stop: [{ matcher: "*", command: "local-stop" }] },
    });

    expect(
      resolveConfig(CWD).hooks?.stop?.map((entry) => "command" in entry && entry.command),
    ).toEqual(["user-stop", "project-stop", "local-stop"]);
  });

  test("a project hook keeps its own timeout while the user hook keeps the default", () => {
    writeJson(join(USER_DIR, "settings.json"), {
      hooks: { postToolUse: [{ matcher: "Bash", command: "user-hook" }] },
    });
    writeJson(projectSettingsPath(CWD, "project"), {
      hooks: { postToolUse: [{ matcher: "Bash", command: "project-hook", timeout: 12 }] },
    });

    expect(resolveConfig(CWD).hooks?.postToolUse).toEqual([
      { matcher: "Bash", command: "user-hook" },
      { matcher: "Bash", command: "project-hook", timeout: 12 },
    ]);
  });

  test("a malformed project hooks block is skipped instead of dropping user hooks", () => {
    writeJson(join(USER_DIR, "settings.json"), {
      hooks: { stop: [{ matcher: "*", command: "user-stop" }] },
    });
    writeJson(projectSettingsPath(CWD, "project"), { hooks: "nonsense" });

    expect(resolveConfig(CWD).hooks?.stop).toEqual([{ matcher: "*", command: "user-stop" }]);
  });
});
