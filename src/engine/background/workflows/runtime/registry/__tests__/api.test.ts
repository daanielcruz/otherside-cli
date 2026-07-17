import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeChildWorkflowHooks } from "@/engine/background/workflows/runtime/launch/launcher.ts";
import { createWorkflowApi } from "@/engine/background/workflows/runtime/registry/api.ts";
import {
  getAllWorkflows,
  resolveWorkflow,
} from "@/engine/background/workflows/runtime/registry/registry.ts";
import type { WorkflowDefinition } from "@/engine/background/workflows/runtime/registry/types.ts";
import type { WorkflowVmHooks } from "@/engine/background/workflows/runtime/runner/context.ts";
import { loadPluginFromDirectory } from "@/engine/plugins/loader.ts";
import * as pluginsRegistry from "@/engine/plugins/registry.ts";
import { DEFAULT_CONFIG } from "@/kernel/config/config.ts";

const tempRoots: string[] = [];

afterEach(() => {
  pluginsRegistry.clear();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "otherside-workflow-api-"));
  tempRoots.push(root);
  return root;
}

describe("scopeChildWorkflowHooks", () => {
  test("prefixes child logs and phases and rejects nested calls", async () => {
    const logs: string[] = [];
    const phases: string[] = [];
    const baseHooks: WorkflowVmHooks = {
      log: (msg) => logs.push(msg),
      phase: (title) => phases.push(title),
    };

    const scoped = scopeChildWorkflowHooks(baseHooks, "child");

    scoped.log?.("hello");
    expect(logs).toEqual(["[child] hello"]);

    scoped.phase?.("Scan");
    expect(phases).toEqual(["▸ child / Scan"]);

    expect(scoped.workflow).toBeDefined();
    await expect(scoped.workflow?.("nested-child")).rejects.toThrow(
      "workflow() cannot be called from within a child workflow",
    );
  });
});

describe("createWorkflowApi with fakes", () => {
  const mockWorkflowDef: WorkflowDefinition = {
    source: "project",
    name: "child",
    description: "mock child description",
    script: `export const meta = {\n  name: "child",\n  description: "mock child description",\n}\nconst helper = 1;\nreturn helper;\n`,
  };

  test("restores the parent phase after success", async () => {
    let currentPhase: string | undefined = "parent-phase";
    const recordedPhases: string[] = [];
    const logs: string[] = [];

    const resolveWorkflowMock = async (name: string): Promise<WorkflowDefinition | undefined> => {
      if (name === "child") return mockWorkflowDef;
      return undefined;
    };

    const getAllWorkflowsMock = async (): Promise<WorkflowDefinition[]> => {
      return [mockWorkflowDef];
    };

    let runChildCalled = 0;
    const runChildMock = async () => {
      runChildCalled++;
      return "child-success";
    };

    const api = createWorkflowApi({
      cwd: "/mock-cwd",
      signal: new AbortController().signal,
      resolveWorkflow: resolveWorkflowMock,
      getAllWorkflows: getAllWorkflowsMock,
      runChild: runChildMock,
      recordPhase: (title) => {
        recordedPhases.push(title);
        currentPhase = title;
      },
      log: (message) => logs.push(message),
      getCurrentPhase: () => currentPhase,
      restoreCurrentPhase: (phase) => {
        currentPhase = phase;
      },
    });

    const result = await api("child");
    expect(result).toBe("child-success");
    expect(runChildCalled).toBe(1);
    expect(recordedPhases).toContain("▸ child");
    expect(currentPhase).toBe("parent-phase");
    expect(logs.some((l) => l.includes("child done"))).toBe(true);
  });

  test("restores the parent phase after failure", async () => {
    let currentPhase: string | undefined = "parent-phase";
    const recordedPhases: string[] = [];
    const logs: string[] = [];

    const resolveWorkflowMock = async (name: string): Promise<WorkflowDefinition | undefined> => {
      if (name === "child") return mockWorkflowDef;
      return undefined;
    };

    const getAllWorkflowsMock = async (): Promise<WorkflowDefinition[]> => {
      return [mockWorkflowDef];
    };

    let runChildCalled = 0;
    const runChildMock = async () => {
      runChildCalled++;
      throw new Error("child-failed");
    };

    const api = createWorkflowApi({
      cwd: "/mock-cwd",
      signal: new AbortController().signal,
      resolveWorkflow: resolveWorkflowMock,
      getAllWorkflows: getAllWorkflowsMock,
      runChild: runChildMock,
      recordPhase: (title) => {
        recordedPhases.push(title);
        currentPhase = title;
      },
      log: (message) => logs.push(message),
      getCurrentPhase: () => currentPhase,
      restoreCurrentPhase: (phase) => {
        currentPhase = phase;
      },
    });

    await expect(api("child")).rejects.toThrow("child-failed");
    expect(runChildCalled).toBe(1);
    expect(recordedPhases).toContain("▸ child");
    expect(currentPhase).toBe("parent-phase");
    expect(logs.some((l) => l.includes("child failed"))).toBe(true);
  });
});

describe("createWorkflowApi plugin workflow resolution", () => {
  test("runs a namespaced plugin workflow through workflow(name)", async () => {
    const root = makeTempRoot();
    const pluginRoot = join(root, "plugins", "api-plugin");
    const workflowsPath = join(pluginRoot, "workflows");
    mkdirSync(workflowsPath, { recursive: true });
    writeFileSync(
      join(pluginRoot, "plugin.json"),
      JSON.stringify({ name: "api-plugin", version: "1.0.0" }),
      "utf8",
    );
    writeFileSync(
      join(workflowsPath, "child.js"),
      'export const meta = { name: "child", description: "plugin child" };\nreturn "ok";\n',
      "utf8",
    );
    const plugin = loadPluginFromDirectory(pluginRoot, "test-plugin-source");
    if (plugin === null) throw new Error("test plugin failed to load");
    pluginsRegistry.register(plugin);

    const recordedPhases: string[] = [];
    const runNames: string[] = [];
    const config = { ...DEFAULT_CONFIG, enableUserWorkflows: false };
    const api = createWorkflowApi({
      cwd: root,
      signal: new AbortController().signal,
      resolveWorkflow: (name, cwd) => resolveWorkflow(name, cwd, config),
      getAllWorkflows: (cwd) => getAllWorkflows(cwd, config),
      runChild: async ({ name }) => {
        runNames.push(name);
        return "plugin-child-success";
      },
      recordPhase: (title) => recordedPhases.push(title),
      log: () => {},
      getCurrentPhase: () => undefined,
      restoreCurrentPhase: () => {},
    });

    await expect(api("api-plugin@test-plugin-source:child")).resolves.toBe("plugin-child-success");
    expect(runNames).toEqual(["api-plugin@test-plugin-source:child"]);
    expect(recordedPhases).toEqual(["▸ api-plugin@test-plugin-source:child"]);
  });
});
