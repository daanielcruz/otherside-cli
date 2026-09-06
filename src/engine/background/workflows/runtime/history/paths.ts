import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WORKFLOW_SCRIPT_MAX_BYTES } from "@/engine/background/workflows/runtime/parser/types.ts";
import { sessionsRootForCwd } from "@/engine/session/paths.ts";
import { errorMessage, isErrno } from "@/kernel/std/errno.ts";

export function getWorkflowRunDir(cwd: string, sessionId: string, runId: string): string {
  return join(sessionsRootForCwd(cwd), sessionId, "subagents", "workflows", runId);
}

export function workflowTranscriptDir(cwd: string, sessionId: string, runId: string): string {
  return getWorkflowRunDir(cwd, sessionId, runId);
}

export function getPersistedWorkflowScriptPath(
  cwd: string,
  sessionId: string,
  runId: string,
  workflowName: string,
): string {
  return join(
    sessionsRootForCwd(cwd),
    sessionId,
    "workflows",
    "scripts",
    `${slugifyWorkflowName(workflowName)}-${runId}.js`,
  );
}

export async function persistWorkflowProgram(input: {
  cwd: string;
  sessionId: string;
  runId: string;
  workflowName: string;
  script: string;
}): Promise<string> {
  const path = getPersistedWorkflowScriptPath(
    input.cwd,
    input.sessionId,
    input.runId,
    input.workflowName,
  );
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, input.script, "utf8");
  return path;
}

export async function loadWorkflowFromPath(
  cwd: string,
  path: string,
): Promise<{ ok: true; script: string; resolvedPath: string } | { ok: false; error: string }> {
  const resolvedPath = resolve(cwd, path);
  try {
    const script = await readFile(resolvedPath, "utf8");
    const byteLength = Buffer.byteLength(script, "utf8");
    if (byteLength > WORKFLOW_SCRIPT_MAX_BYTES) {
      return {
        ok: false,
        error: `Workflow script file ${resolvedPath} is ${byteLength} bytes; max ${WORKFLOW_SCRIPT_MAX_BYTES}`,
      };
    }
    return { ok: true, script, resolvedPath };
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { ok: false, error: `Workflow script file not found: ${resolvedPath}` };
    }
    return {
      ok: false,
      error: `Failed to read workflow script file ${resolvedPath}: ${errorMessage(error)}`,
    };
  }
}

export function slugifyWorkflowName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "workflow";
}
