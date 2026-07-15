import { readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { parseWorkflowScript } from "@/engine/background/workflows/runtime/parser/meta.ts";
import { WORKFLOW_SCRIPT_MAX_BYTES } from "@/engine/background/workflows/runtime/parser/types.ts";
import type { WorkflowDefinition } from "@/engine/background/workflows/runtime/registry/types.ts";
import * as pluginsRegistry from "@/engine/plugins/registry.ts";

const SCRIPT_EXTENSION = ".js";

export async function getPluginWorkflows(): Promise<WorkflowDefinition[]> {
  const seenPaths = new Set<string>();
  const collected: WorkflowDefinition[] = [];

  for (const plugin of pluginsRegistry.list()) {
    if (!pluginsRegistry.isRuntimeEnabled(plugin.name) || !plugin.workflowsPath) continue;
    collected.push(...(await loadPluginWorkflowsFromDir(plugin, seenPaths)));
  }

  return collected;
}

async function loadPluginWorkflowsFromDir(
  plugin: ReturnType<typeof pluginsRegistry.list>[number],
  seenPaths: Set<string>,
): Promise<WorkflowDefinition[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(plugin.workflowsPath!, { withFileTypes: true });
  } catch {
    return [];
  }

  const loaded = await Promise.all(
    entries.map((entry) => loadPluginWorkflowEntry(plugin, entry, seenPaths)),
  );
  return loaded.filter((workflow): workflow is WorkflowDefinition => workflow !== null);
}

async function loadPluginWorkflowEntry(
  plugin: ReturnType<typeof pluginsRegistry.list>[number],
  entry: import("node:fs").Dirent,
  seenPaths: Set<string>,
): Promise<WorkflowDefinition | null> {
  if (!entry.isFile() && !entry.isSymbolicLink()) return null;
  if (!entry.name.endsWith(SCRIPT_EXTENSION)) return null;

  const filePath = join(plugin.workflowsPath!, entry.name);
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(filePath);
  } catch {
    return null;
  }
  if (seenPaths.has(resolvedPath)) return null;
  seenPaths.add(resolvedPath);

  let script: string;
  try {
    script = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  if (Buffer.byteLength(script, "utf8") > WORKFLOW_SCRIPT_MAX_BYTES) return null;

  try {
    const parsed = parseWorkflowScript(script);
    return {
      source: "plugin",
      plugin,
      pluginManifest: plugin.manifest,
      name: `${plugin.name}:${parsed.meta.name}`,
      description: parsed.meta.description,
      script,
      filePath,
      ...(parsed.meta.whenToUse !== undefined ? { whenToUse: parsed.meta.whenToUse } : {}),
      ...(parsed.meta.phases !== undefined ? { phases: parsed.meta.phases } : {}),
    };
  } catch {
    return null;
  }
}
