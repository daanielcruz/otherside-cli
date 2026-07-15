import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveProjectMcpServer,
  disableMcpServer,
  getProjectMcpServerStatus,
  isMcpServerAllowedByPolicy,
  isMcpServerDenied,
  loadEffectiveMcpConfigWithSources,
  loadEnabledMcpConfig,
  rejectProjectMcpServer,
} from "@/kernel/mcp/config.ts";
import { getRuntimeKind, setRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
import { isYoloMode, setYoloMode } from "@/kernel/std/proc/yolo-mode.ts";

const TMP = mkdtempSync(join(tmpdir(), "mcp-config-"));
const USER_DIR = join(TMP, "user");
const CWD = join(TMP, "project");
const LOCAL_SETTINGS = join(CWD, ".otherside", "settings.local.json");
const PROJECT_SETTINGS = join(CWD, ".otherside", "settings.json");

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeProjectMcp(serverNames: string[]): void {
  writeJson(join(CWD, ".mcp.json"), {
    mcpServers: Object.fromEntries(
      serverNames.map((name) => [name, { type: "stdio", command: "example", args: [] }]),
    ),
  });
}

async function enabledServerNames(): Promise<string[]> {
  const config = await loadEnabledMcpConfig(CWD);
  return Object.keys(config.mcpServers).sort((a, b) => a.localeCompare(b));
}

const originalRuntimeKind = getRuntimeKind();
const originalYoloMode = isYoloMode();

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(USER_DIR, { recursive: true });
  mkdirSync(join(CWD, ".otherside"), { recursive: true });
  process.env.OTHERSIDE_CONFIG_DIR = USER_DIR;
});

afterEach(() => {
  delete process.env.OTHERSIDE_CONFIG_DIR;
  rmSync(TMP, { recursive: true, force: true });
  setRuntimeKind(originalRuntimeKind);
  setYoloMode(originalYoloMode);
});

describe("project MCP server trust", () => {
  test("starts servers added after enable-all approval", async () => {
    writeProjectMcp(["first"]);
    await approveProjectMcpServer(CWD, "first", true);
    expect(await enabledServerNames()).toEqual(["first"]);
    expect(JSON.parse(readFileSync(LOCAL_SETTINGS, "utf8"))).toMatchObject({
      enabledMcpjsonServers: ["first"],
      enableAllProjectMcpServers: true,
    });

    writeProjectMcp(["first", "new-server"]);
    expect(await enabledServerNames()).toEqual(["first", "new-server"]);
  });

  test("keeps disabled servers stopped even when enable-all is set", async () => {
    writeJson(LOCAL_SETTINGS, { enableAllProjectMcpServers: true });
    writeProjectMcp(["allowed", "blocked"]);
    await rejectProjectMcpServer(CWD, "blocked");

    expect(await enabledServerNames()).toEqual(["allowed"]);
    expect(await getProjectMcpServerStatus(CWD, "blocked")).toBe("rejected");
    expect(JSON.parse(readFileSync(LOCAL_SETTINGS, "utf8"))).toMatchObject({
      disabledMcpjsonServers: ["blocked"],
    });
  });

  test("rejects a project denial despite local explicit and blanket approval", async () => {
    writeJson(PROJECT_SETTINGS, { disabledMcpjsonServers: ["evil"] });
    writeJson(LOCAL_SETTINGS, {
      enabledMcpjsonServers: ["evil"],
      enableAllProjectMcpServers: true,
    });
    writeProjectMcp(["evil"]);

    expect(await getProjectMcpServerStatus(CWD, "evil")).toBe("rejected");
    expect(await enabledServerNames()).toEqual([]);
  });

  test("excludes an undecided server until it is accepted", async () => {
    writeProjectMcp(["pending"]);
    expect(await getProjectMcpServerStatus(CWD, "pending")).toBe("pending");
    expect(await enabledServerNames()).toEqual([]);

    await approveProjectMcpServer(CWD, "pending");
    expect(await enabledServerNames()).toEqual(["pending"]);
    expect(JSON.parse(readFileSync(LOCAL_SETTINGS, "utf8"))).toMatchObject({
      enabledMcpjsonServers: ["pending"],
    });
  });

  test("honors the legacy mcpTrustAccepted key as enable-all", async () => {
    writeJson(LOCAL_SETTINGS, { mcpTrustAccepted: true });
    writeProjectMcp(["legacy-trusted"]);

    expect(await enabledServerNames()).toEqual(["legacy-trusted"]);
  });

  test("auto-approves a pending project server in noninteractive (print) sessions", async () => {
    writeProjectMcp(["pending"]);
    setRuntimeKind("print");

    expect(await getProjectMcpServerStatus(CWD, "pending")).toBe("approved");
    expect(await enabledServerNames()).toEqual(["pending"]);
  });

  test("still rejects an explicitly disabled project server in noninteractive sessions", async () => {
    writeJson(LOCAL_SETTINGS, { disabledMcpjsonServers: ["blocked"] });
    writeProjectMcp(["blocked"]);
    setRuntimeKind("print");

    expect(await getProjectMcpServerStatus(CWD, "blocked")).toBe("rejected");
    expect(await enabledServerNames()).toEqual([]);
  });

  test("keeps a pending project server pending outside noninteractive sessions", async () => {
    writeProjectMcp(["pending"]);
    setRuntimeKind("interactive");

    expect(await getProjectMcpServerStatus(CWD, "pending")).toBe("pending");
    expect(await enabledServerNames()).toEqual([]);
  });

  test("auto-approves a pending project server in an interactive yolo session", async () => {
    writeProjectMcp(["probe"]);
    setRuntimeKind("interactive");
    setYoloMode(true);

    expect(await getProjectMcpServerStatus(CWD, "probe")).toBe("approved");
    expect(await enabledServerNames()).toEqual(["probe"]);
  });

  test("still rejects an explicitly disabled project server in a yolo session", async () => {
    writeJson(LOCAL_SETTINGS, { disabledMcpjsonServers: ["blocked"] });
    writeProjectMcp(["blocked"]);
    setRuntimeKind("interactive");
    setYoloMode(true);

    expect(await getProjectMcpServerStatus(CWD, "blocked")).toBe("rejected");
    expect(await enabledServerNames()).toEqual([]);
  });

  test("keeps a pending project server pending outside yolo mode", async () => {
    writeProjectMcp(["pending"]);
    setRuntimeKind("interactive");
    setYoloMode(false);

    expect(await getProjectMcpServerStatus(CWD, "pending")).toBe("pending");
    expect(await enabledServerNames()).toEqual([]);
  });
});

describe("local MCP scope", () => {
  test("loads a server configured only in the local scope, without needing project trust", async () => {
    writeJson(LOCAL_SETTINGS, {
      mcpServers: {
        "local-only": { type: "stdio", command: "example", args: [] },
      },
    });

    const loaded = await loadEffectiveMcpConfigWithSources(CWD);
    expect(loaded.sources["local-only"]?.scope).toBe("local");
    expect(loaded.sources["local-only"]?.path).toBe(LOCAL_SETTINGS);

    // No project trust decision was ever recorded for this server — it must
    // still be enabled, unlike a project-scope (.mcp.json) server would be.
    expect(await getProjectMcpServerStatus(CWD, "local-only")).toBe("pending");
    expect(await enabledServerNames()).toEqual(["local-only"]);
  });

  test("gives local scope the highest manual-scope precedence over project and user", async () => {
    writeJson(join(CWD, ".mcp.json"), {
      mcpServers: { shared: { type: "stdio", command: "from-project", args: [] } },
    });
    writeJson(LOCAL_SETTINGS, {
      enableAllProjectMcpServers: true,
      mcpServers: {
        shared: { type: "stdio", command: "from-local", args: [] },
      },
    });

    const loaded = await loadEffectiveMcpConfigWithSources(CWD);
    expect(loaded.sources.shared?.scope).toBe("local");
    const config = await loadEnabledMcpConfig(CWD);
    expect(config.mcpServers.shared).toMatchObject({ command: "from-local" });
  });

  test("explicit deny still wins over a local-scope server", async () => {
    writeJson(LOCAL_SETTINGS, {
      mcpServers: {
        "local-only": { type: "stdio", command: "example", args: [] },
      },
    });
    await disableMcpServer(CWD, "local-only");

    expect(await enabledServerNames()).toEqual([]);
  });
});

describe("enterprise MCP policy allow/deny (managed-settings.json)", () => {
  test("deniedMcpServers by name blocks a server before it ever connects, even with blanket trust", async () => {
    writeJson(join(USER_DIR, "managed-settings.json"), {
      deniedMcpServers: [{ serverName: "evil" }],
    });
    writeJson(LOCAL_SETTINGS, { enableAllProjectMcpServers: true });
    writeProjectMcp(["evil", "good"]);

    // Project trust alone would approve both; the policy denylist still wins.
    expect(await getProjectMcpServerStatus(CWD, "evil")).toBe("approved");
    expect(await enabledServerNames()).toEqual(["good"]);
    expect(isMcpServerDenied(CWD, "evil")).toBe(true);
  });

  test("deniedMcpServers by exact stdio command array blocks regardless of server name", async () => {
    writeJson(join(USER_DIR, "managed-settings.json"), {
      deniedMcpServers: [{ serverCommand: ["npx", "evil-tool"] }],
    });
    writeJson(LOCAL_SETTINGS, {
      enableAllProjectMcpServers: true,
      mcpServers: {
        renamed: { type: "stdio", command: "npx", args: ["evil-tool"] },
      },
    });

    expect(await enabledServerNames()).toEqual([]);
  });

  test("deniedMcpServers by URL wildcard pattern blocks a remote server", async () => {
    writeJson(join(USER_DIR, "managed-settings.json"), {
      deniedMcpServers: [{ serverUrl: "https://evil.example.com/*" }],
    });
    writeJson(LOCAL_SETTINGS, {
      mcpServers: {
        remote: { type: "http", url: "https://evil.example.com/mcp" },
      },
    });

    expect(await enabledServerNames()).toEqual([]);
  });

  test("allowedMcpServers restricts the enabled set to only listed names", async () => {
    writeJson(join(USER_DIR, "managed-settings.json"), {
      allowedMcpServers: [{ serverName: "good" }],
    });
    writeJson(LOCAL_SETTINGS, { enableAllProjectMcpServers: true });
    writeProjectMcp(["good", "other"]);

    expect(await enabledServerNames()).toEqual(["good"]);
  });

  test("an empty allowedMcpServers list blocks every server", async () => {
    writeJson(join(USER_DIR, "managed-settings.json"), { allowedMcpServers: [] });
    writeJson(LOCAL_SETTINGS, { enableAllProjectMcpServers: true });
    writeProjectMcp(["good"]);

    expect(await enabledServerNames()).toEqual([]);
  });

  test("with no allowedMcpServers set, a non-denied server is unaffected", async () => {
    writeJson(join(USER_DIR, "managed-settings.json"), {
      deniedMcpServers: [{ serverName: "evil" }],
    });
    writeJson(LOCAL_SETTINGS, { enableAllProjectMcpServers: true });
    writeProjectMcp(["good"]);

    expect(await enabledServerNames()).toEqual(["good"]);
  });

  test("denylist takes precedence over allowlist when a server matches both", async () => {
    writeJson(join(USER_DIR, "managed-settings.json"), {
      allowedMcpServers: [{ serverName: "evil" }],
      deniedMcpServers: [{ serverName: "evil" }],
    });

    expect(isMcpServerAllowedByPolicy(CWD, "evil")).toBe(false);
    expect(isMcpServerDenied(CWD, "evil")).toBe(true);
  });

  test("a project .mcp.json cannot exempt itself from an enterprise denylist", async () => {
    // The malicious/blocked server is defined at project scope (committed
    // .mcp.json) and the user has fully trusted this project — only the
    // policy-sourced denylist, which the project cannot write to, stops it.
    writeJson(join(USER_DIR, "managed-settings.json"), {
      deniedMcpServers: [{ serverName: "evil" }],
    });
    writeJson(PROJECT_SETTINGS, { enableAllProjectMcpServers: true });
    writeProjectMcp(["evil"]);

    expect(await getProjectMcpServerStatus(CWD, "evil")).toBe("approved");
    expect(await enabledServerNames()).toEqual([]);
  });

  test("existing project-trust ask/deny handling is untouched when no policy is configured", async () => {
    // No managed-settings.json at all: policy allow/deny is a no-op, and the
    // pre-existing project-trust "pending" behavior (independent of policy)
    // is unaffected.
    writeProjectMcp(["pending"]);

    expect(await getProjectMcpServerStatus(CWD, "pending")).toBe("pending");
    expect(await enabledServerNames()).toEqual([]);
    expect(isMcpServerAllowedByPolicy(CWD, "pending")).toBe(true);
  });
});
