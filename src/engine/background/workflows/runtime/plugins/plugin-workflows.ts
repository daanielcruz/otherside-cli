import { readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { parseWorkflowScript } from "@/engine/background/workflows/runtime/parser/meta.ts";
import { WORKFLOW_SCRIPT_MAX_BYTES } from "@/engine/background/workflows/runtime/parser/types.ts";
import type { WorkflowDefinition } from "@/engine/background/workflows/runtime/registry/types.ts";
import type { PluginRegistryEntry } from "@/engine/plugins/registry.ts";
import * as pluginsRegistry from "@/engine/plugins/registry.ts";

const SCRIPT_EXTENSION = ".js";

export async function getPluginWorkflows(options?: {
  entries?: readonly PluginRegistryEntry[];
}): Promise<WorkflowDefinition[]> {
  const seenPaths = new Set<string>();
  const collected: WorkflowDefinition[] = [];
  const entries = options?.entries ?? pluginsRegistry.list();

  for (const { pluginId, plugin } of entries) {
    if (!options?.entries && !pluginsRegistry.isRuntimeEnabled(pluginId)) continue;
    collected.push(...(await loadPluginWorkflowsFromDir(pluginId, plugin, seenPaths)));
  }

  return collected;
}

async function loadPluginWorkflowsFromDir(
  pluginId: string,
  plugin: ReturnType<typeof pluginsRegistry.list>[number]["plugin"],
  seenPaths: Set<string>,
): Promise<WorkflowDefinition[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(plugin.workflowsPath!, { withFileTypes: true });
  } catch {
    return [];
  }

  const loaded = await Promise.all(
    entries.map((entry) => loadPluginWorkflowEntry(pluginId, plugin, entry, seenPaths)),
  );
  return loaded.filter((workflow): workflow is WorkflowDefinition => workflow !== null);
}

async function loadPluginWorkflowEntry(
  pluginId: string,
  plugin: ReturnType<typeof pluginsRegistry.list>[number]["plugin"],
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
      name: `${pluginId}:${parsed.meta.name}`,
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
