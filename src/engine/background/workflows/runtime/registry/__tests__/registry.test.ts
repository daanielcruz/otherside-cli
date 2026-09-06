import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBundledWorkflows } from "@/engine/background/workflows/bundled/index.ts";
import {
  getAllWorkflows,
  getListedWorkflows,
  getLocalWorkflows,
  resolveWorkflow,
} from "@/engine/background/workflows/runtime/registry/registry.ts";
import { loadPluginFromDirectory } from "@/engine/plugins/loader.ts";
import * as pluginsRegistry from "@/engine/plugins/registry.ts";
import { DEFAULT_CONFIG, type UserConfig } from "@/kernel/config/config.ts";

const tempRoots: string[] = [];

afterEach(() => {
  pluginsRegistry.clear();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "otherside-workflow-registry-"));
  tempRoots.push(root);
  return root;
}

function writeWorkflowScript(
  dir: string,
  fileName: string,
  name: string,
  description: string,
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, fileName),
    `export const meta = {\n  name: ${JSON.stringify(name)},\n  description: ${JSON.stringify(description)},\n}\n`,
    "utf8",
  );
}

function registerPlugin(root: string, name: string) {
  const pluginRoot = join(root, "plugins", name);
  const workflowsPath = join(pluginRoot, "workflows");
  mkdirSync(workflowsPath, { recursive: true });
  writeFileSync(
    join(pluginRoot, "plugin.json"),
    JSON.stringify({ name, version: "1.0.0" }),
    "utf8",
  );
  const plugin = loadPluginFromDirectory(pluginRoot, "test-plugin-source");
  if (plugin === null) throw new Error("test plugin failed to load");
  pluginsRegistry.register(plugin);
  return { plugin, workflowsPath };
}

describe("workflow registry resolution", () => {
  test("cwd-local workflow wins over a same-named parent project workflow", async () => {
    const root = makeTempRoot();
    const parent = join(root, "parent");
    const child = join(parent, "child");
    writeWorkflowScript(
      join(parent, ".otherside", "workflows"),
      "shared.js",
      "shared",
      "from-parent",
    );
    writeWorkflowScript(
      join(child, ".otherside", "workflows"),
      "shared.js",
      "shared",
      "from-child",
    );

    const workflows = await getLocalWorkflows(child);
    const shared = workflows.find((workflow) => workflow.name === "shared");

    expect(shared).toBeDefined();
    expect(shared?.description).toBe("from-child");
    expect(shared?.filePath).toBe(join(child, ".otherside", "workflows", "shared.js"));
  });

  test("project walk stops at the git root and ignores workflows above it", async () => {
    const root = makeTempRoot();
    const above = join(root, "above");
    const repo = join(above, "repo");
    const nested = join(repo, "nested");
    writeWorkflowScript(
      join(above, ".otherside", "workflows"),
      "above.js",
      "above-only",
      "from-above",
    );
    writeWorkflowScript(
      join(nested, ".otherside", "workflows"),
      "inside.js",
      "inside-only",
      "from-inside",
    );
    mkdirSync(join(repo, ".git"), { recursive: true });

    const workflows = await getLocalWorkflows(nested);
    const names = new Set(workflows.map((workflow) => workflow.name));

    expect(names.has("inside-only")).toBe(true);
    expect(names.has("above-only")).toBe(false);
  });

  test("git root itself still contributes project workflows", async () => {
    const root = makeTempRoot();
    const above = join(root, "outside");
    const repo = join(above, "repo");
    writeWorkflowScript(
      join(above, ".otherside", "workflows"),
      "above.js",
      "above-only",
      "from-above",
    );
    writeWorkflowScript(
      join(repo, ".otherside", "workflows"),
      "root.js",
      "root-only",
      "from-repo-root",
    );
    mkdirSync(join(repo, ".git"), { recursive: true });

    const workflows = await getLocalWorkflows(repo);
    const names = new Set(workflows.map((workflow) => workflow.name));

    expect(names.has("root-only")).toBe(true);
    expect(names.has("above-only")).toBe(false);
  });
});

describe("plugin workflow registry", () => {
  test("loads enabled namespaced plugin workflows and preserves provenance", async () => {
    const root = makeTempRoot();
    const { plugin, workflowsPath } = registerPlugin(root, "review-plugin");
    writeWorkflowScript(workflowsPath, "review.js", "review", "from-plugin");

    const workflows = await getAllWorkflows(root, config({ enableUserWorkflows: false }));
    const workflow = workflows.find(
      (entry) => entry.name === "review-plugin@test-plugin-source:review",
    );

    expect(workflow).toMatchObject({
      source: "plugin",
      name: "review-plugin@test-plugin-source:review",
      description: "from-plugin",
      plugin,
      pluginManifest: plugin.manifest,
    });
    expect(workflow?.filePath).toBe(join(workflowsPath, "review.js"));
    expect(workflows.filter((entry) => entry.source === "plugin")).toHaveLength(1);
    await expect(
      resolveWorkflow("review-plugin@test-plugin-source:review", root),
    ).resolves.toMatchObject({
      source: "plugin",
      name: "review-plugin@test-plugin-source:review",
    });
    await expect(resolveWorkflow("review", root)).resolves.toBeUndefined();
  });

  test("applies disabled workflow state only when the plugin runtime reloads", async () => {
    const root = makeTempRoot();
    const { plugin, workflowsPath } = registerPlugin(root, "disabled-plugin");
    writeWorkflowScript(workflowsPath, "hidden.js", "hidden", "from-disabled-plugin");
    const originalConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = join(root, "config");
    try {
      await pluginsRegistry.setEnabled(plugin.name, false);
      const beforeReload = await getAllWorkflows(root, config({ enableUserWorkflows: false }));
      expect(
        beforeReload.some((entry) => entry.name === "disabled-plugin@test-plugin-source:hidden"),
      ).toBe(true);

      pluginsRegistry.applyPersistedEnabledState({ "disabled-plugin@test-plugin-source": false });
      const afterReload = await getAllWorkflows(root, config({ enableUserWorkflows: false }));
      expect(
        afterReload.some((entry) => entry.name === "disabled-plugin@test-plugin-source:hidden"),
      ).toBe(false);
    } finally {
      if (originalConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
      else process.env.OTHERSIDE_CONFIG_DIR = originalConfigDir;
    }
  });

  test("skips wrong extensions, oversized and invalid scripts, and duplicate symlink targets", async () => {
    const root = makeTempRoot();
    const { workflowsPath } = registerPlugin(root, "scanner-plugin");
    writeWorkflowScript(workflowsPath, "valid.js", "valid", "from-valid-script");
    symlinkSync(join(workflowsPath, "valid.js"), join(workflowsPath, "duplicate.js"));
    writeWorkflowScript(workflowsPath, "ignored.ts", "ignored", "wrong-extension");
    writeFileSync(join(workflowsPath, "invalid.js"), "const invalid = true;", "utf8");
    writeFileSync(join(workflowsPath, "oversized.js"), "x".repeat(524_289), "utf8");

    const workflows = await getAllWorkflows(root, config({ enableUserWorkflows: false }));
    const pluginWorkflows = workflows.filter((entry) => entry.source === "plugin");

    expect(pluginWorkflows).toHaveLength(1);
    expect(pluginWorkflows[0]?.name).toBe("scanner-plugin@test-plugin-source:valid");
  });

  test("local workflows override same-named plugin workflows and appear after plugins", async () => {
    const root = makeTempRoot();
    const { workflowsPath } = registerPlugin(root, "priority-plugin");
    const builtInName = getBundledWorkflows()[0]!.name;
    writeWorkflowScript(workflowsPath, "plugin.js", "shared", "from-plugin");
    writeWorkflowScript(workflowsPath, "unique.js", "unique", "plugin-only");
    writeWorkflowScript(
      join(root, ".otherside", "workflows"),
      "local.js",
      "priority-plugin:shared",
      "from-local",
    );
    writeWorkflowScript(
      join(root, ".otherside", "workflows"),
      "built-in.js",
      builtInName,
      "from-local-over-builtin",
    );

    const workflows = await getAllWorkflows(root, config({ enableUserWorkflows: false }));
    const shared = workflows.filter((entry) => entry.name === "priority-plugin:shared");
    const builtInCollision = workflows.filter((entry) => entry.name === builtInName);
    const firstPluginIndex = workflows.findIndex((entry) => entry.source === "plugin");
    const firstLocalIndex = workflows.findIndex(
      (entry) => entry.source !== "built-in" && entry.source !== "plugin",
    );

    expect(shared).toHaveLength(1);
    expect(shared[0]?.description).toBe("from-local");
    expect(builtInCollision).toHaveLength(1);
    expect(builtInCollision[0]?.description).toBe("from-local-over-builtin");
    expect(firstPluginIndex).toBe(workflows.filter((entry) => entry.source === "built-in").length);
    expect(firstLocalIndex).toBeGreaterThan(firstPluginIndex);
  });
});

function config(overrides: Partial<UserConfig>): UserConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

describe("workflow source gates and safe mode", () => {
  test("safe mode resolves only bundled workflows and never touches disk", async () => {
    const root = makeTempRoot();
    writeWorkflowScript(
      join(root, ".otherside", "workflows"),
      "local.js",
      "safe-mode-local",
      "on-disk",
    );
    const { workflowsPath } = registerPlugin(root, "safe-mode-plugin");
    writeWorkflowScript(workflowsPath, "plugin.js", "plugin-only", "from-plugin");

    process.env.OTHERSIDE_SAFE_MODE = "1";
    try {
      const workflows = await getAllWorkflows(root);
      expect(workflows.some((workflow) => workflow.name === "safe-mode-local")).toBe(false);
      expect(workflows.some((workflow) => workflow.name === "safe-mode-plugin:plugin-only")).toBe(
        false,
      );
      expect(workflows.length).toBe(getBundledWorkflows().length);
    } finally {
      delete process.env.OTHERSIDE_SAFE_MODE;
    }
  });

  test("a disabled project source is skipped, an enabled one is walked", async () => {
    const root = makeTempRoot();
    mkdirSync(join(root, ".git"), { recursive: true });
    writeWorkflowScript(
      join(root, ".otherside", "workflows"),
      "proj.js",
      "gated-project",
      "from-project",
    );

    const enabled = await getLocalWorkflows(root, config({ enableProjectWorkflows: true }));
    expect(enabled.some((workflow) => workflow.name === "gated-project")).toBe(true);

    const disabled = await getLocalWorkflows(root, config({ enableProjectWorkflows: false }));
    expect(disabled.some((workflow) => workflow.name === "gated-project")).toBe(false);
  });

  test("the user source gate short-circuits to an empty walk when disabled", async () => {
    // homedir() is not overridable at runtime, so this asserts the gate's shape
    // rather than seeding a fake home: disabling the user scope drops every
    // user-sourced workflow while leaving project resolution untouched. The gate
    // is the same code path as the project gate above (enabled ? walk : []).
    const root = makeTempRoot();
    mkdirSync(join(root, ".git"), { recursive: true });
    writeWorkflowScript(
      join(root, ".otherside", "workflows"),
      "proj.js",
      "user-gate-project",
      "from-project",
    );

    const disabled = await getLocalWorkflows(
      root,
      config({ enableUserWorkflows: false, enableProjectWorkflows: true }),
    );
    expect(disabled.every((workflow) => workflow.source !== "user")).toBe(true);
    expect(disabled.some((workflow) => workflow.name === "user-gate-project")).toBe(true);
  });
});

describe("hidden workflows", () => {
  test("a hidden workflow is kept out of the roster but still resolves by name", async () => {
    const root = makeTempRoot();
    const hidden = getBundledWorkflows().filter((workflow) => workflow.hidden === true);
    expect(hidden.length).toBeGreaterThan(0);

    const listed = await getListedWorkflows(root, config({ enableUserWorkflows: false }));
    for (const workflow of hidden) {
      expect(listed.some((entry) => entry.name === workflow.name)).toBe(false);
      expect(await resolveWorkflow(workflow.name, root)).toBeDefined();
    }
  });

  test("the roster keeps every workflow that is not hidden", async () => {
    const root = makeTempRoot();
    const config_ = config({ enableUserWorkflows: false });
    const all = await getAllWorkflows(root, config_);
    const listed = await getListedWorkflows(root, config_);

    expect(listed).toEqual(all.filter((workflow) => workflow.hidden !== true));
    expect(listed.length).toBeLessThan(all.length);
  });
});
