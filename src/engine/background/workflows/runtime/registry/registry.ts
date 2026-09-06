import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getBundledWorkflows } from "@/engine/background/workflows/bundled/index.ts";
import { parseWorkflowScript } from "@/engine/background/workflows/runtime/parser/meta.ts";
import { WORKFLOW_SCRIPT_MAX_BYTES } from "@/engine/background/workflows/runtime/parser/types.ts";
import { getPluginWorkflows } from "@/engine/background/workflows/runtime/plugins/plugin-workflows.ts";
import type {
  WorkflowDefinition,
  WorkflowSource,
} from "@/engine/background/workflows/runtime/registry/types.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import { resolveConfig } from "@/kernel/config/resolver.ts";
import { findGitRoot } from "@/kernel/std/fs/git-root.ts";
import { isSafeMode } from "@/kernel/std/proc/env.ts";

const WORKFLOWS_DIR_SEGMENTS = [".otherside", "workflows"];
const SCRIPT_EXTENSION = ".js";

// Per-source gates default to enabled when unset so a fresh config keeps
// today's behavior. Safe mode is a launch-time posture (env/argv), evaluated
// separately so it holds even when config is unreadable.
function userWorkflowsEnabled(config: UserConfig): boolean {
  return config.enableUserWorkflows ?? true;
}

function projectWorkflowsEnabled(config: UserConfig): boolean {
  return config.enableProjectWorkflows ?? true;
}

export async function getAllWorkflows(
  cwd: string,
  config?: UserConfig,
): Promise<WorkflowDefinition[]> {
  // Safe mode never touches disk: only the trusted built-ins are resolvable.
  if (isSafeMode()) return getBundledWorkflows();
  const [local, plugin] = await Promise.all([getLocalWorkflows(cwd, config), getPluginWorkflows()]);
  const localNames = new Set(local.map((workflow) => workflow.name));
  const pluginUnique = plugin.filter((workflow) => !localNames.has(workflow.name));
  const taken = new Set([...localNames, ...pluginUnique.map((workflow) => workflow.name)]);
  const bundled = getBundledWorkflows().filter((workflow) => !taken.has(workflow.name));
  return [...bundled, ...pluginUnique, ...local];
}

/**
 * The roster a caller may offer when asked what exists. A hidden workflow stays
 * resolvable by name — its own command launches it that way — but never advertises
 * itself, so the roster holds only what a user can meaningfully pick.
 */
export async function getListedWorkflows(
  cwd: string,
  config?: UserConfig,
): Promise<WorkflowDefinition[]> {
  return (await getAllWorkflows(cwd, config)).filter((workflow) => workflow.hidden !== true);
}

export async function resolveWorkflow(
  name: string,
  cwd: string,
  config?: UserConfig,
): Promise<WorkflowDefinition | undefined> {
  return (await getAllWorkflows(cwd, config)).find((workflow) => workflow.name === name);
}

export async function getLocalWorkflows(
  cwd: string,
  config?: UserConfig,
): Promise<WorkflowDefinition[]> {
  const resolved = config ?? resolveConfig(cwd);
  // A disabled source is skipped before any readdir, not filtered after — a
  // scope turned off must not incur a disk walk of that scope.
  const userDir = userWorkflowsEnabled(resolved)
    ? join(homedir(), ...WORKFLOWS_DIR_SEGMENTS)
    : null;
  const projectDirs = projectWorkflowsEnabled(resolved) ? projectWorkflowDirs(cwd) : [];
  const [userWorkflows, ...projectWorkflowLists] = await Promise.all([
    userDir === null
      ? Promise.resolve<WorkflowDefinition[]>([])
      : loadWorkflowsFromDirectory(userDir, "user"),
    ...projectDirs.map((dir) => loadWorkflowsFromDirectory(dir, "project")),
  ]);
  const byName = new Map<string, WorkflowDefinition>();
  for (const workflow of userWorkflows) byName.set(workflow.name, workflow);
  // Ancestor lists first, cwd-nearest last so the closest definition wins collisions.
  for (let index = projectWorkflowLists.length - 1; index >= 0; index -= 1) {
    for (const workflow of projectWorkflowLists[index]!) {
      byName.set(workflow.name, workflow);
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function projectWorkflowDirs(cwd: string): string[] {
  const home = homedir();
  const gitRoot = findGitRoot(cwd);
  const dirs: string[] = [];
  let current = cwd;
  for (let depth = 0; depth < 64; depth += 1) {
    // Home is loaded as the separate user scope — never as a project dir.
    if (current === home) break;
    dirs.push(join(current, ...WORKFLOWS_DIR_SEGMENTS));
    // Stop after the repository root so parent trees outside the repo cannot leak in.
    if (gitRoot !== null && current === gitRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

async function loadWorkflowsFromDirectory(
  dir: string,
  source: WorkflowSource,
): Promise<WorkflowDefinition[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const loaded = await Promise.all(
    entries.map((entry) => loadWorkflowEntry({ dir, entry, source })),
  );
  return loaded.filter((workflow): workflow is WorkflowDefinition => workflow !== null);
}

async function loadWorkflowEntry(input: {
  dir: string;
  entry: import("node:fs").Dirent;
  source: WorkflowSource;
}): Promise<WorkflowDefinition | null> {
  if (!input.entry.isFile() && !input.entry.isSymbolicLink()) return null;
  if (!input.entry.name.endsWith(SCRIPT_EXTENSION)) return null;
  const filePath = join(input.dir, input.entry.name);
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
      source: input.source,
      name: parsed.meta.name,
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
