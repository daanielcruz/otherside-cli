import { compileWorkflowScript } from "@/engine/background/workflows/runtime/compiler/compile.ts";
import { readWorkflowFromPath } from "@/engine/background/workflows/runtime/history/paths.ts";
import { parseWorkflowScript } from "@/engine/background/workflows/runtime/parser/meta.ts";
import type { WorkflowDefinition } from "@/engine/background/workflows/runtime/registry/types.ts";
import { buildVmSafeError } from "@/engine/background/workflows/runtime/sandbox/errors.ts";

const PHASE_MARKER = "▸";

export interface WorkflowChildRun {
  vmScript: import("node:vm").Script;
  name: string;
  args: unknown;
}

export interface WorkflowApiOptions {
  cwd: string;
  signal: AbortSignal;
  resolveWorkflow: (name: string, cwd: string) => Promise<WorkflowDefinition | undefined>;
  getAllWorkflows: (cwd: string) => Promise<WorkflowDefinition[]>;
  runChild: (run: WorkflowChildRun) => Promise<unknown>;
  recordPhase: (title: string) => void;
  log: (message: string) => void;
  getCurrentPhase: () => string | undefined;
  restoreCurrentPhase: (phase: string | undefined) => void;
}

export type WorkflowApiHook = (ref: unknown, args?: unknown) => Promise<unknown>;

export function createWorkflowApi(options: WorkflowApiOptions): WorkflowApiHook {
  const phaseCounts = new Map<string, number>();

  return async (ref: unknown, args?: unknown): Promise<unknown> => {
    if (options.signal.aborted) return new Promise<never>(() => {});
    const resolved = await resolveWorkflowReference(ref, options);
    const compiled = compileWorkflowScript(resolved.body);
    if (!compiled.ok) {
      throw buildVmSafeError(`workflow('${resolved.name}'): ${compiled.error}`);
    }
    const phaseLabel = nextPhaseLabel(phaseCounts, resolved.name);
    const parentPhase = options.getCurrentPhase();
    options.recordPhase(phaseLabel);
    options.log(`${PHASE_MARKER} running dynamic workflow ${resolved.name}`);
    try {
      const result = await options.runChild({
        vmScript: compiled.vmScript,
        name: resolved.name,
        args,
      });
      options.log(`${PHASE_MARKER} ${resolved.name} done`);
      return result;
    } catch (error) {
      const safe = buildVmSafeError(error);
      options.log(`${PHASE_MARKER} ${resolved.name} failed: ${safe.message}`);
      throw safe;
    } finally {
      options.restoreCurrentPhase(parentPhase);
    }
  };
}

export function createNestedWorkflowRejectHook(): WorkflowApiHook {
  return () =>
    Promise.reject(
      buildVmSafeError(
        "workflow() cannot be called from within a child workflow — nesting is limited to one level. Inline the inner script or call its agents directly.",
      ),
    );
}

async function resolveWorkflowReference(
  ref: unknown,
  options: WorkflowApiOptions,
): Promise<{ name: string; body: string }> {
  if (typeof ref === "string") {
    const resolved = await options.resolveWorkflow(ref, options.cwd);
    if (!resolved) {
      const available = (await options.getAllWorkflows(options.cwd))
        .map((workflow) => workflow.name)
        .join(", ");
      throw buildVmSafeError(
        `workflow('${ref}'): no workflow with that name. Available: ${available || "(none)"}`,
      );
    }
    return { name: resolved.name, body: parseWorkflowScript(resolved.script).body };
  }
  const scriptPath = readScriptPathReference(ref);
  if (scriptPath !== undefined) {
    const loaded = await readWorkflowFromPath(options.cwd, scriptPath);
    if (!loaded.ok)
      throw buildVmSafeError(`workflow({scriptPath: '${scriptPath}'}): ${loaded.error}`);
    const parsed = parseWorkflowScript(loaded.script);
    return { name: parsed.meta.name, body: parsed.body };
  }
  throw buildVmSafeError("workflow() expects a workflow name (string) or {scriptPath: string}.");
}

function readScriptPathReference(ref: unknown): string | undefined {
  if (ref === null || typeof ref !== "object" || Array.isArray(ref)) return undefined;
  const value = "scriptPath" in ref ? Reflect.get(ref, "scriptPath") : undefined;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nextPhaseLabel(phaseCounts: Map<string, number>, name: string): string {
  const count = (phaseCounts.get(name) ?? 0) + 1;
  phaseCounts.set(name, count);
  return `${PHASE_MARKER} ${name}${count > 1 ? ` #${count}` : ""}`;
}
