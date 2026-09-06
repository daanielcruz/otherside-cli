import type { WorkflowPhaseSpec } from "@/engine/background/workflows/runtime/parser/types.ts";
import type { LoadedPlugin } from "@/engine/plugins/loader.ts";
import type { PluginManifest } from "@/engine/plugins/manifest.ts";

export type WorkflowSource = "built-in" | "user" | "project" | "plugin";

export interface WorkflowDefinition {
  source: WorkflowSource;
  name: string;
  description: string;
  script: string;
  whenToUse?: string;
  phases?: WorkflowPhaseSpec[];
  filePath?: string;
  plugin?: LoadedPlugin;
  pluginManifest?: PluginManifest;
  hidden?: boolean;
}
