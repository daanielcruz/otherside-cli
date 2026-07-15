import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigSync } from "@/kernel/config/config.ts";
import { resolveConfig } from "@/kernel/config/resolver.ts";
import {
  projectSettingsPath,
  readProjectSettings,
  writeProjectSettings,
} from "@/kernel/config/scope.ts";
import { updateSetting } from "@/kernel/config/update-setting.ts";

const TMP = mkdtempSync(join(tmpdir(), "resolver-"));
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

describe("resolveConfig", () => {
  test("precedence override + set-union + policy ceiling", () => {
    writeJson(join(USER_DIR, "settings.json"), {
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-8",
      defaultMode: "default",
      disabledMcpServers: ["a"],
    });
    writeJson(join(CWD, ".otherside", "settings.json"), {
      defaultMode: "accept-edits",
      disabledMcpServers: ["b"],
    });
    writeJson(join(CWD, ".otherside", "settings.local.json"), {
      disabledMcpServers: ["c"],
    });
    writeJson(join(USER_DIR, "managed-settings.json"), { defaultMode: "plan" });

    const resolved = resolveConfig(CWD);

    // policy is last in precedence → its defaultMode beats the project override
    expect(resolved.defaultMode).toBe("plan");
    // union across user + project + local, deduped
    expect(new Set(resolved.disabledMcpServers)).toEqual(new Set(["a", "b", "c"]));
    // scalar only present at user scope is untouched
    expect(resolved.defaultProvider).toBe("anthropic");
  });

  test("garbage value at project scope is skipped, user base wins", () => {
    writeJson(join(USER_DIR, "settings.json"), { defaultMode: "plan" });
    writeJson(join(CWD, ".otherside", "settings.json"), { defaultMode: "garbage" });

    expect(resolveConfig(CWD).defaultMode).toBe("plan");
  });
});

describe("writeProjectSettings", () => {
  test("atomically writes project settings without temp residue", () => {
    writeProjectSettings(CWD, "project", (file) => {
      file.disabledMcpServers = ["server-a", "server-b"];
      file.mcpTrustAccepted = true;
    });

    const path = projectSettingsPath(CWD, "project");
    const entries = readdirSync(join(CWD, ".otherside"));
    expect(entries.filter((entry) => entry.startsWith("settings.json.tmp."))).toEqual([]);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      disabledMcpServers: ["server-a", "server-b"],
      mcpTrustAccepted: true,
    });
    expect(readProjectSettings(CWD, "project")).toEqual({
      disabledMcpServers: ["server-a", "server-b"],
      mcpTrustAccepted: true,
    });
  });
});

describe("updateSetting", () => {
  test("user-scope write round-trips through loadConfigSync", async () => {
    await updateSetting("autoCompact", true);
    expect(loadConfigSync().autoCompact).toBe(true);
  });

  test("rejects an invalid value", async () => {
    await expect(updateSetting("autoCompact", "nope" as unknown as boolean)).rejects.toThrow();
  });

  test("effortLevel user-scope write round-trips through loadConfigSync", async () => {
    await updateSetting("effortLevel", "medium");
    expect(loadConfigSync().effortLevel).toBe("medium");
  });

  test("effortLevel rejects an invalid value", async () => {
    await expect(updateSetting("effortLevel", "nope" as never)).rejects.toThrow();
  });
});
