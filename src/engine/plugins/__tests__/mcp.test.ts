import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { encodePluginPathSegment } from "@/engine/plugins/installations.ts";
import type { LoadedPlugin } from "@/engine/plugins/loader.ts";
import type { PluginManifest } from "@/engine/plugins/manifest.ts";
import { gatherPluginMcpServers } from "@/engine/plugins/mcp.ts";
import { applyPersistedEnabledState, clear, register } from "@/engine/plugins/registry.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";

describe("gatherPluginMcpServers", () => {
  beforeEach(() => {
    clear();
  });

  it("adapts and namespaces stdio servers, resolving relative args against the plugin dir", () => {
    const pluginDir = resolve("/mock-plugins/demo");
    const manifest: PluginManifest = {
      name: "demo",
      mcpServers: { api: { command: "node", args: ["server.js"], cwd: "runtime" } },
    };
    register({
      name: "demo",
      path: pluginDir,
      source: "demo",
      manifest,
    } as unknown as LoadedPlugin);
    const out = gatherPluginMcpServers({
      existsSync: (p) => p === join(pluginDir, "server.js"),
    });
    expect(Object.keys(out)).toEqual(["plugin:demo@demo:api"]);
    expect(out["plugin:demo@demo:api"]).toEqual({
      type: "stdio",
      command: "node",
      args: [join(pluginDir, "server.js")],
      env: {
        CLAUDE_PLUGIN_ROOT: pluginDir,
        CLAUDE_PLUGIN_DATA: join(
          configRoot(),
          "plugins",
          "data",
          encodePluginPathSegment("demo@demo"),
        ),
      },
      cwd: join(pluginDir, "runtime"),
    });
  });

  it("expands ${CLAUDE_PLUGIN_ROOT} in command/args/env and injects it into the env", () => {
    const pluginDir = "/mock-plugins/rooted";
    const manifest: PluginManifest = {
      name: "rooted",
      mcpServers: {
        api: {
          command: "${CLAUDE_PLUGIN_ROOT}/bin/run",
          args: ["--data", "${CLAUDE_PLUGIN_ROOT}/data"],
          env: { DATA_DIR: "${CLAUDE_PLUGIN_ROOT}/data" },
        },
      },
    };
    register({
      name: "rooted",
      path: pluginDir,
      source: "rooted",
      manifest,
    } as unknown as LoadedPlugin);
    expect(gatherPluginMcpServers()["plugin:rooted@rooted:api"]).toEqual({
      type: "stdio",
      command: `${pluginDir}/bin/run`,
      args: ["--data", `${pluginDir}/data`],
      env: {
        CLAUDE_PLUGIN_ROOT: pluginDir,
        CLAUDE_PLUGIN_DATA: join(
          configRoot(),
          "plugins",
          "data",
          encodePluginPathSegment("rooted@rooted"),
        ),
        DATA_DIR: `${pluginDir}/data`,
      },
    });
  });

  it("expands ${CLAUDE_PLUGIN_ROOT} in http url and headers", () => {
    const pluginDir = "/mock-plugins/rooted-http";
    const manifest: PluginManifest = {
      name: "rootedhttp",
      mcpServers: {
        web: {
          url: "https://x/${CLAUDE_PLUGIN_ROOT}",
          headers: { "X-Root": "${CLAUDE_PLUGIN_ROOT}" },
        },
      },
    };
    register({
      name: "rootedhttp",
      path: pluginDir,
      source: "rootedhttp",
      manifest,
    } as unknown as LoadedPlugin);
    expect(gatherPluginMcpServers()["plugin:rootedhttp@rootedhttp:web"]).toEqual({
      type: "http",
      url: `https://x/${pluginDir}`,
      headers: { "X-Root": pluginDir },
    });
  });

  it("adapts http servers with OAuth scopes", () => {
    const manifest: PluginManifest = {
      name: "remote",
      mcpServers: {
        web: { url: "https://example.com/mcp", oauth: { scope: "openid profile" } },
      },
    };
    register({
      name: "remote",
      path: "/mock-plugins/remote",
      source: "remote",
      manifest,
    } as unknown as LoadedPlugin);
    const out = gatherPluginMcpServers();
    expect(out["plugin:remote@remote:web"]).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      oauthScopes: "openid profile",
    });
  });

  it("loads default and manifest-path MCP files with manifest entries winning", () => {
    const pluginDir = mkdtempSync(join(tmpdir(), "plugin-mcp-paths-"));
    try {
      writeFileSync(
        join(pluginDir, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            base: { command: "node", args: ["base.js"] },
            shared: { url: "https://default.example/mcp" },
          },
        }),
      );
      writeFileSync(
        join(pluginDir, "extra.json"),
        JSON.stringify({ shared: { type: "sse", url: "https://override.example/sse" } }),
      );
      const manifest: PluginManifest = { name: "strform", mcpServers: "./extra.json" };
      register({
        name: "strform",
        path: pluginDir,
        source: "strform",
        manifest,
      } as unknown as LoadedPlugin);

      const servers = gatherPluginMcpServers();
      expect(Object.keys(servers).sort()).toEqual([
        "plugin:strform@strform:base",
        "plugin:strform@strform:shared",
      ]);
      expect(servers["plugin:strform@strform:shared"]).toEqual({
        type: "sse",
        url: "https://override.example/sse",
      });
    } finally {
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it("merges MCP arrays in declaration order and rejects paths outside the plugin", () => {
    const pluginDir = mkdtempSync(join(tmpdir(), "plugin-mcp-array-"));
    try {
      writeFileSync(
        join(pluginDir, "first.json"),
        JSON.stringify({ one: { url: "https://first.example/mcp" } }),
      );
      const manifest: PluginManifest = {
        name: "arrayform",
        mcpServers: [
          "./first.json",
          "../outside.json",
          { one: { url: "https://second.example/mcp" } },
        ],
      };
      register({
        name: "arrayform",
        path: pluginDir,
        source: "arrayform",
        manifest,
      } as unknown as LoadedPlugin);

      expect(gatherPluginMcpServers()).toEqual({
        "plugin:arrayform@arrayform:one": { type: "http", url: "https://second.example/mcp" },
      });
    } finally {
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it("keeps loaded MCP exposure unchanged until persisted state is applied on reload", () => {
    const manifest: PluginManifest = {
      name: "layered",
      mcpServers: { web: { url: "https://example.com/mcp" } },
    };
    register({
      name: "layered",
      path: "/mock-plugins/layered",
      source: "layered",
      manifest,
    } as unknown as LoadedPlugin);

    expect(gatherPluginMcpServers()["plugin:layered@layered:web"]).toBeDefined();
    applyPersistedEnabledState({ "layered@layered": false });
    expect(gatherPluginMcpServers()).toEqual({});
  });
});
