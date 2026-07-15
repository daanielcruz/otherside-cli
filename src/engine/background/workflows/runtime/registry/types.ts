import type { WorkflowPhaseDescriptor } from "@/engine/background/workflows/runtime/parser/types.ts";
import type { LoadedPlugin } from "@/engine/plugins/loader.ts";
import type { PluginManifest } from "@/engine/plugins/manifest.ts";

export type WorkflowSource = "built-in" | "user" | "project" | "plugin";

export interface WorkflowDefinition {
  source: WorkflowSource;
  name: string;
  description: string;
  script: string;
  whenToUse?: string;
  phases?: WorkflowPhaseDescriptor[];
  filePath?: string;
  plugin?: LoadedPlugin;
  pluginManifest?: PluginManifest;
  hidden?: boolean;
}
