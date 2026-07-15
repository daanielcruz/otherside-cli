import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LoadedPlugin } from "@/engine/plugins/loader.ts";
import * as plugins from "@/engine/plugins/registry.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import { activePlanFilePath } from "@/engine/tools/plan-gate.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import {
  _resetAutoMemorySessionForTesting,
  isAutoMemoryEnabled,
} from "@/kernel/storage/memory/session-toggle.ts";
import { dispatch, listCompletions, looksLikeCommand, lookup } from "../dispatch.ts";
import { commandHint } from "../hints.ts";
import type { SlashContext } from "../types.ts";

let useMock = false;
let lastUpdatedConfig: Partial<UserConfig> | null = null;

function expectLastUpdatedConfig(expected: Partial<UserConfig>): void {
  expect(lastUpdatedConfig).toEqual(expected);
}

const { updateConfig: realUpdateConfig, ...otherConfig } = await import(
  "@/kernel/config/config.ts"
);

mock.module("@/kernel/config/config.ts", () => {
  return {
    ...otherConfig,
    updateConfig: (mutator: (cfg: UserConfig) => void) => {
      if (useMock) {
        const cfg = {} as UserConfig;
        mutator(cfg);
        lastUpdatedConfig = cfg;
        return Promise.resolve(cfg);
      }
      return realUpdateConfig(mutator);
    },
  };
});

describe("dispatch unknown commands", () => {
  it("validates looksLikeCommand correctly", () => {
    expect(looksLikeCommand("agn")).toBe(true);
    expect(looksLikeCommand("usr/bin")).toBe(false);
    expect(looksLikeCommand("")).toBe(false);
    expect(looksLikeCommand("cmd-name")).toBe(true);
    expect(looksLikeCommand("cmd_name")).toBe(true);
    expect(looksLikeCommand("cmd:name")).toBe(true);
    expect(looksLikeCommand("cmd.name")).toBe(false);
  });

  it("handles unknown commands without suggestions", async () => {
    const dummyCtx = {} as SlashContext;
    const result = await dispatch("/xyzqwe", dummyCtx);
    expect(result.kind).toBe("unknown");
    expect(result.feedback).toBe("Unknown command: /xyzqwe");
  });

  it("handles unknown commands with suggestions", async () => {
    const dummyCtx = {} as SlashContext;
    const result = await dispatch("/exi", dummyCtx);
    expect(result.kind).toBe("unknown");
    expect(result.feedback).toBe("Unknown command: /exi. Did you mean /exit?");
  });

  it("appends arguments warning for unknown skills", async () => {
    const dummyCtx = {} as SlashContext;
    const result = await dispatch("/exi some args", dummyCtx);
    expect(result.kind).toBe("unknown");
    expect(result.feedback).toBe(
      "Unknown command: /exi. Did you mean /exit?\nArgs from unknown skill: some args",
    );
  });

  it("bypasses local intercept and sets shouldQuery for path-like commands", async () => {
    const dummyCtx = {} as SlashContext;
    const result = await dispatch("/tmp/otherside-dispatch-fixture", dummyCtx);
    expect(result.kind).toBe("unknown");
    expect(result.shouldQuery).toBe(true);
  });

  it("bypasses local intercept and sets shouldQuery for commands failing looksLikeCommand", async () => {
    const dummyCtx = {} as SlashContext;
    const result = await dispatch("/usr/bin", dummyCtx);
    expect(result.kind).toBe("unknown");
    expect(result.shouldQuery).toBe(true);
  });
});

describe("slash command hints", () => {
  it("keeps every autocomplete hint concise", () => {
    const commands = listCompletions("");
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command.description.split(/\s+/).length).toBeLessThanOrEqual(7);
    }
  });

  it("uses a short hint for deep security review", () => {
    expect(commandHint("deep-security-review", "an intentionally long skill description")).toBe(
      "audit repository security",
    );
  });
});

describe("config toggles via slash", () => {
  afterEach(() => {
    useMock = false;
  });

  it("toggles parallel tasks and accepts explicit on/off", async () => {
    useMock = true;
    lastUpdatedConfig = null;
    const off = { config: { parallelTasks: false } } as SlashContext;
    expect((await dispatch("/parallel", off)).feedback).toBe("Parallel tasks enabled");
    expectLastUpdatedConfig({ parallelTasks: true });

    lastUpdatedConfig = null;
    const on = { config: { parallelTasks: true } } as SlashContext;
    expect((await dispatch("/parallel off", on)).feedback).toBe("Parallel tasks disabled");
    expectLastUpdatedConfig({ parallelTasks: false });

    lastUpdatedConfig = null;
    expect((await dispatch("/parallel invalid", off)).feedback).toBe("Usage: /parallel [on|off]");
    expect(lastUpdatedConfig).toBeNull();
  });

  it("toggles multiprovider and keeps orchestrator mode in sync", async () => {
    useMock = true;
    lastUpdatedConfig = null;
    const off = { config: { tierSelectorEnabled: false } } as SlashContext;
    expect((await dispatch("/multiprovider on", off)).feedback).toBe("Multiprovider enabled");
    expectLastUpdatedConfig({ tierSelectorEnabled: true, orchestratorMode: "soft" });

    lastUpdatedConfig = null;
    const on = { config: { tierSelectorEnabled: true } } as SlashContext;
    expect((await dispatch("/multiprovider", on)).feedback).toBe("Multiprovider disabled");
    expectLastUpdatedConfig({ tierSelectorEnabled: false, orchestratorMode: "off" });

    lastUpdatedConfig = null;
    expect((await dispatch("/multiprovider invalid", off)).feedback).toBe(
      "Usage: /multiprovider [on|off]",
    );
    expect(lastUpdatedConfig).toBeNull();
  });
});

describe("handleEffort via dispatch", () => {
  beforeAll(() => {
    registerAllProviders();
  });

  afterEach(() => {
    useMock = false;
  });

  it("persists effortLevel on valid-level branch and returns new feedback", async () => {
    const dummyCtx = {
      broker: {
        read: () => ({
          model: "claude-opus-4-8",
          provider: "anthropic",
          effort: "high" as const,
        }),
        dispatch: () => {},
      },
    } as unknown as SlashContext;

    lastUpdatedConfig = null;
    useMock = true;
    const result = await dispatch("/effort medium", dummyCtx);

    expect(result.kind).toBe("panel");
    expect(result.feedback).toBe(
      "Set effort level to medium (saved as your default for new sessions): Balanced approach with standard implementation and testing",
    );
    expect(result.pendingChange).toEqual({ kind: "set_effort", effort: "medium" });
    expectLastUpdatedConfig({ effortLevel: "medium" });
  });

  it("clears effortLevel on auto/unset", async () => {
    const dummyCtx = {
      broker: {
        read: () => ({
          model: "claude-opus-4-8",
          provider: "anthropic",
          effort: "high" as const,
        }),
        dispatch: () => {},
      },
    } as unknown as SlashContext;

    lastUpdatedConfig = null;
    useMock = true;
    const result = await dispatch("/effort auto", dummyCtx);

    expect(result.kind).toBe("panel");
    expect(result.feedback).toBe("Set effort auto (xhigh)");
    expect(result.pendingChange).toEqual({ kind: "set_effort", effort: "xhigh" });
    expectLastUpdatedConfig({});
  });

  it("persists ultracode on ultracode branch", async () => {
    const dummyCtx = {
      broker: {
        read: () => ({
          model: "claude-opus-4-8",
          provider: "anthropic",
          effort: "high" as const,
        }),
        dispatch: () => {},
      },
      config: {
        enableWorkflows: true,
      },
    } as unknown as SlashContext;

    lastUpdatedConfig = null;
    useMock = true;
    const result = await dispatch("/effort ultracode", dummyCtx);

    expect(result.kind).toBe("panel");
    expect(result.pendingChange).toEqual({ kind: "set_ultracode", enabled: true });
    expectLastUpdatedConfig({ ultracode: true });
  });
});

describe("/plan via dispatch", () => {
  it("enters plan mode when not already active", async () => {
    const dispatched: unknown[] = [];
    const dummyCtx = {
      broker: {
        read: () => ({ permissionMode: "default" }),
        dispatch: (event: unknown) => dispatched.push(event),
      },
    } as unknown as SlashContext;

    const result = await dispatch("/plan", dummyCtx);

    expect(result.kind).toBe("toggle");
    expect(result.feedback).toBe("Entered plan mode");
    expect(dispatched).toEqual([{ kind: "set_permission_mode", mode: "plan" }]);
  });

  it("renders the current plan locally without exiting or starting an API turn", async () => {
    const priorConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    const configDir = mkdtempSync(join(tmpdir(), "otherside-plan-command-"));
    process.env.OTHERSIDE_CONFIG_DIR = configDir;
    const dispatched: unknown[] = [];
    let modelCalls = 0;
    const sessionId = "plan-command-session";
    const planFile = activePlanFilePath(sessionId);
    mkdirSync(dirname(planFile), { recursive: true });
    writeFileSync(planFile, "# Captured plan\n\n1. Inspect locally.\n", "utf8");
    const dummyCtx = {
      broker: {
        read: () => ({ permissionMode: "plan", prePlanMode: "default" }),
        dispatch: (event: unknown) => dispatched.push(event),
      },
      session: { id: sessionId },
      agent: { run: () => (modelCalls += 1) },
    } as unknown as SlashContext;

    try {
      const result = await dispatch("/plan", dummyCtx);

      expect(result.kind).toBe("toggle");
      expect(result.feedback).toBe(
        [
          "Current Plan",
          planFile,
          "",
          "# Captured plan\n\n1. Inspect locally.",
          "",
          '"/plan open" to edit this plan',
        ].join("\n"),
      );
      expect(dispatched).toEqual([]);
      expect(modelCalls).toBe(0);
    } finally {
      if (priorConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
      else process.env.OTHERSIDE_CONFIG_DIR = priorConfigDir;
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("toggle-memory via dispatch", () => {
  afterEach(() => {
    _resetAutoMemorySessionForTesting();
  });

  it("flips the session override and reports the new state", async () => {
    const dummyCtx = {} as SlashContext;
    const initial = isAutoMemoryEnabled();

    const flipped = await dispatch("/toggle-memory", dummyCtx);
    expect(flipped.kind).toBe("toggle");
    expect(isAutoMemoryEnabled()).toBe(!initial);
    expect(flipped.feedback).toBe(
      !initial ? "Auto memory enabled for this session" : "Auto memory disabled for this session",
    );

    const restored = await dispatch("/toggle-memory", dummyCtx);
    expect(isAutoMemoryEnabled()).toBe(initial);
    expect(restored.feedback).toBe(
      initial ? "Auto memory enabled for this session" : "Auto memory disabled for this session",
    );
  });
});

describe("plugin commands via dispatch", () => {
  afterEach(() => {
    useMock = false;
    plugins.clear();
  });

  it("registers reload and marketplace command surfaces", () => {
    expect(lookup("reload-plugins")?.name).toBe("reload");
    expect(lookup("marketplace")?.name).toBe("marketplace");
  });

  it("routes marketplace commands independently from the plugin panel", async () => {
    const result = await dispatch("/marketplace list", {} as SlashContext);
    expect(result.kind).toBe("instant");
    expect(result.feedback).toMatch(/marketplaces/i);
  });

  it("opens the plugin panel for /plugins without arguments", async () => {
    const opened: string[] = [];
    const result = await dispatch("/plugins", {
      openOverlay: (name: string) => {
        opened.push(name);
      },
    } as unknown as SlashContext);

    expect(result.kind).toBe("panel");
    expect(result.feedback).toBeUndefined();
    expect(opened).toEqual(["plugins"]);
  });

  it("persists plugin toggles and reports that a reload is required", async () => {
    const plugin: LoadedPlugin = {
      name: "demo-plugin",
      path: "/plugins/demo-plugin",
      source: "test",
      manifest: { name: "demo-plugin" },
    };
    plugins.register(plugin);
    useMock = true;

    const opened: string[] = [];
    const { peekPendingPluginCommandResult, clearPendingPluginCommandResult } = await import(
      "@/ui/panels/plugins/command-result.ts"
    );
    clearPendingPluginCommandResult();
    const result = await dispatch("/plugin disable demo-plugin", {
      openOverlay: (name: string) => {
        opened.push(name);
      },
    } as unknown as SlashContext);

    // Mutating /plugin commands open the panel with feedback inside it.
    expect(result.kind).toBe("panel");
    expect(result.feedback).toBeUndefined();
    expect(opened).toEqual(["plugins"]);
    expect(peekPendingPluginCommandResult()).toBe(
      "Disabled plugin demo-plugin. Run /reload-plugins to apply.",
    );
    expect(plugins.isEnabled("demo-plugin")).toBe(false);
    expect(plugins.isRuntimeEnabled("demo-plugin")).toBe(true);
    clearPendingPluginCommandResult();
  });

  it("opens all mutating plugin subcommands with their feedback in the panel", async () => {
    const { consumePendingPluginCommandResult, clearPendingPluginCommandResult } = await import(
      "@/ui/panels/plugins/command-result.ts"
    );

    for (const subcommand of ["install", "update", "enable", "disable", "uninstall", "remove"]) {
      clearPendingPluginCommandResult();
      const opened: string[] = [];
      const result = await dispatch(`/plugin ${subcommand}`, {
        openOverlay: (name: string) => {
          opened.push(name);
        },
      } as unknown as SlashContext);

      expect(result.kind).toBe("panel");
      expect(result.feedback).toBeUndefined();
      expect(opened).toEqual(["plugins"]);
      expect(consumePendingPluginCommandResult()).toMatch(/^Usage: \/plugin/);
    }
  });

  it("keeps non-mutating plugin list commands on the transcript path", async () => {
    for (const command of ["/plugin list", "/plugin marketplace list"]) {
      const opened: string[] = [];
      const result = await dispatch(command, {
        openOverlay: (name: string) => {
          opened.push(name);
        },
      } as unknown as SlashContext);

      expect(result.kind).toBe("instant");
      expect(result.feedback).toMatch(/No plugins installed|Installed plugins|marketplaces/i);
      expect(opened).toEqual([]);
    }
  });
});
