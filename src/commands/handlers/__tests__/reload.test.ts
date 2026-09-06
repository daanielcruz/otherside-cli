import { afterEach, describe, expect, it } from "bun:test";
import { countPluginHooks, formatReloadFeedback } from "@/commands/handlers/reload.ts";
import type { LoadedPlugin } from "@/engine/plugins/loader.ts";
import * as plugins from "@/engine/plugins/registry.ts";

function makePlugin(name: string, hooksConfig?: LoadedPlugin["hooksConfig"]): LoadedPlugin {
  return {
    name,
    path: `/tmp/${name}`,
    source: "test",
    manifest: { name },
    ...(hooksConfig ? { hooksConfig } : {}),
  };
}

afterEach(() => {
  plugins.clear();
});

describe("formatReloadFeedback", () => {
  it("formats the category set, order, separator, and pluralization", () => {
    expect(
      formatReloadFeedback({
        plugins: 2,
        skills: 1,
        agents: 0,
        hooks: 3,
        mcpServers: 1,
        lspServers: 4,
      }),
    ).toBe(
      "Reloaded: 2 plugins · 1 skill · 0 agents · 3 hooks · 1 plugin MCP server · 4 plugin LSP servers",
    );
  });

  it("lists agent files that failed to parse under the counts", () => {
    expect(
      formatReloadFeedback({
        plugins: 0,
        skills: 0,
        agents: 1,
        hooks: 0,
        mcpServers: 0,
        lspServers: 0,
        agentFailures: [
          "Failed to parse agent file /tmp/agents/broken.md: missing frontmatter fence",
        ],
      }),
    ).toBe(
      "Reloaded: 0 plugins · 0 skills · 1 agent · 0 hooks · 0 plugin MCP servers · 0 plugin LSP servers\n" +
        "Failed to parse agent file /tmp/agents/broken.md: missing frontmatter fence",
    );
  });

  it("uses plural forms for multi-word MCP/LSP labels", () => {
    expect(
      formatReloadFeedback({
        plugins: 0,
        skills: 0,
        agents: 0,
        hooks: 0,
        mcpServers: 2,
        lspServers: 0,
      }),
    ).toBe(
      "Reloaded: 0 plugins · 0 skills · 0 agents · 0 hooks · 2 plugin MCP servers · 0 plugin LSP servers",
    );
  });
});

describe("countPluginHooks", () => {
  it("counts only runtime-enabled plugin-contributed hook entries", () => {
    plugins.register(
      makePlugin("alpha", {
        Notification: [
          { matcher: "*", command: "notify-a" },
          { matcher: "*", command: "notify-b" },
        ],
        stop: [{ matcher: "*", command: "stop-a" }],
      }),
    );
    plugins.register(
      makePlugin("beta", {
        preToolUse: [{ matcher: "Bash", command: "check" }],
      }),
    );
    plugins.register(makePlugin("gamma"));

    // Runtime-disable beta only (desired + runtime via applyPersistedEnabledState)
    plugins.applyPersistedEnabledState({ "beta@test": false });

    expect(countPluginHooks()).toBe(3);
  });

  it("returns 0 when no plugins contribute hooks", () => {
    plugins.register(makePlugin("empty"));
    expect(countPluginHooks()).toBe(0);
  });
});
