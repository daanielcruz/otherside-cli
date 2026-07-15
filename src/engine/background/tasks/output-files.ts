import { rmSync } from "node:fs";
import { mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, normalize, sep } from "node:path";
import { projectSlug } from "@/kernel/std/fs/paths.ts";

let sessionTaskDir: string | null = null;
let cleanupRegistered = false;
let activeSessionId: string | null = null;

export function getActiveSessionId(): string | null {
  return activeSessionId;
}

function uidSegment(): string {
  return typeof process.getuid === "function" ? String(process.getuid()) : "u";
}

function tmpRoot(): string {
  return join(tmpdir(), `otherside-${uidSegment()}`);
}

function resolveTaskDir(): string {
  return sessionTaskDir ?? join(tmpRoot(), "default", `pid-${process.pid}`, "tasks");
}

function registerSessionCleanupOnce(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const cleanup = (): void => {
    const dir = sessionTaskDir;
    if (dir === null) return;
    if (!dir.startsWith(`${tmpRoot()}${sep}`)) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
}

export function setTaskOutputSession(opts: { sessionId: string; cwd: string }): void {
  activeSessionId = opts.sessionId;
  const session = opts.sessionId.replace(/[^A-Za-z0-9_-]/g, "_") || "session";
  sessionTaskDir = join(tmpRoot(), projectSlug(opts.cwd), session, "tasks");
  registerSessionCleanupOnce();
}

export function getTaskOutputDir(): string {
  return resolveTaskDir();
}

function sanitizeTaskFileId(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9_-]/g, "_");
}

// A task's artifacts live on one path for the whole process: the session task
// dir is rebound mid-flight (/clear, resume), and a task that spans the rebind
// would otherwise keep appending to the old path while completion
// notifications and readers resolve the new one. The first resolution for a
// task id pins its directory; every later writer and reader agrees with it.
const pinnedTaskDirByTaskId = new Map<string, string>();

function taskDirFor(taskId: string): string {
  const pinned = pinnedTaskDirByTaskId.get(taskId);
  if (pinned !== undefined) return pinned;
  const dir = resolveTaskDir();
  pinnedTaskDirByTaskId.set(taskId, dir);
  return dir;
}

export function resetTaskOutputPathPins(): void {
  pinnedTaskDirByTaskId.clear();
}

export function getTaskOutputPath(taskId: string): string {
  return join(taskDirFor(taskId), `${sanitizeTaskFileId(taskId)}.log`);
}

export type ShellStreamName = "stdout" | "stderr";

export function getTaskSpillPath(opts: { taskId: string; stream: ShellStreamName }): string {
  return join(taskDirFor(opts.taskId), `${sanitizeTaskFileId(opts.taskId)}.${opts.stream}.spill`);
}

export function isTaskOutputPath(p: string): boolean {
  const normalized = normalize(p);
  const dirs = new Set(pinnedTaskDirByTaskId.values());
  dirs.add(resolveTaskDir());
  for (const dir of dirs) {
    if (normalized.startsWith(`${dir}${sep}`) || normalized === dir) return true;
  }
  return false;
}

const LOG_SUFFIX = ".log";

export function taskIdFromOutputPath(p: string): string | null {
  if (!isTaskOutputPath(p)) return null;
  const base = basename(normalize(p));
  if (!base.endsWith(LOG_SUFFIX)) return null;
  const id = base.slice(0, -LOG_SUFFIX.length);
  return id.length > 0 ? id : null;
}

export async function writeTaskOutput(taskId: string, content: string): Promise<string> {
  const path = getTaskOutputPath(taskId);
  await mkdir(taskDirFor(taskId), { recursive: true });
  await writeFile(path, content, "utf8");
  return path;
}

// Links the task output path to a file that is streamed during the run (the
// agent's transcript), so the path advertised to the model exists from launch
// instead of only after completion.
export async function linkTaskOutput(taskId: string, targetPath: string): Promise<void> {
  const path = getTaskOutputPath(taskId);
  await mkdir(taskDirFor(taskId), { recursive: true });
  try {
    await symlink(targetPath, path);
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") throw error;
    await unlink(path);
    await symlink(targetPath, path);
  }
}

export async function writeTaskOutputIfAbsent(taskId: string, content: string): Promise<void> {
  const path = getTaskOutputPath(taskId);
  await mkdir(taskDirFor(taskId), { recursive: true });
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") throw error;
  }
}

function errnoCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const { code } = error;
  return typeof code === "string" ? code : null;
}

const TASK_MAX_OUTPUT_DEFAULT = 32_000;
const TASK_MAX_OUTPUT_UPPER_LIMIT = 160_000;

export function getMaxTaskOutputLength(): number {
  const raw = process.env.TASK_MAX_OUTPUT_LENGTH;
  if (!raw) return TASK_MAX_OUTPUT_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return TASK_MAX_OUTPUT_DEFAULT;
  return Math.min(parsed, TASK_MAX_OUTPUT_UPPER_LIMIT);
}

export function formatTaskOutput(
  output: string,
  taskId: string,
): { content: string; wasTruncated: boolean } {
  const maxLen = getMaxTaskOutputLength();
  if (output.length <= maxLen) return { content: output, wasTruncated: false };
  const header = `[Truncated. Full output: ${getTaskOutputPath(taskId)}]\n\n`;
  const truncated = output.slice(-(maxLen - header.length));
  return { content: `${header}${truncated}`, wasTruncated: true };
}
