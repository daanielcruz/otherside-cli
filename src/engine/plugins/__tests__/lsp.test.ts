import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { deferredToolNames } from "@/engine/tools/index.ts";
import { specForFile } from "@/kernel/lsp/client.ts";
import type { LoadedPlugin } from "../loader.ts";
import { gatherPluginLspServerSpecs, hasEnabledPluginLspServers } from "../lsp.ts";
import type { PluginManifest } from "../manifest.ts";
import { clear, register } from "../registry.ts";

describe("plugin LSP server contributions", () => {
  beforeEach(() => {
    clear();
  });

  afterEach(() => {
    clear();
  });

  it("does not advertise the LSP tool without plugin server contributions", () => {
    expect(hasEnabledPluginLspServers()).toBe(false);
    expect(deferredToolNames()).not.toContain("LSP");
  });

  it("advertises the LSP tool and exposes plugin specs to the client", () => {
    const pluginDir = "/virtual/plugins/demo";
    const manifest: PluginManifest = {
      name: "demo",
      lspServers: {
        demo: {
          command: "bin/demo-lsp",
          args: ["--stdio", "config.json"],
          env: { DEMO_ROOT: "data" },
          cwd: "workspace",
          extensionToLanguage: { ".demo": "demoLang" },
        },
      },
    };
    register({
      name: "demo",
      path: pluginDir,
      source: "demo",
      manifest,
    } as unknown as LoadedPlugin);

    expect(hasEnabledPluginLspServers()).toBe(true);
    expect(deferredToolNames()).toContain("LSP");

    const specs = gatherPluginLspServerSpecs({
      existsSync: (path) =>
        path === join(pluginDir, "bin/demo-lsp") || path === join(pluginDir, "config.json"),
    });
    expect(specs).toHaveLength(1);
    expect(specForFile("/workspace/file.demo", specs)).toMatchObject({
      command: join(pluginDir, "bin/demo-lsp"),
      args: ["--stdio", join(pluginDir, "config.json")],
      languages: ["demoLang"],
      extensions: [".demo"],
      extensionToLanguage: { ".demo": "demoLang" },
      env: { DEMO_ROOT: "data" },
      cwd: join(pluginDir, "workspace"),
      pluginId: "demo@demo",
      serverName: "demo",
    });
    expect(specForFile("/workspace/app.ts", specs)?.command).toBe("typescript-language-server");
  });
});
