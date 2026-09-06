import { rmSync } from "node:fs";
import { mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, normalize, sep } from "node:path";
import { projectSlug } from "@/kernel/std/fs/paths.ts";

const artifactState = {
  selectedFolder: null as string | null,
  cleanupReady: false,
  selectedSession: null as string | null,
  taskHomes: new Map<string, string>(),
};

export function getActiveSessionId(): string | null {
  return artifactState.selectedSession;
}

function processOwnerSegment(): string {
  const readUid = process.getuid;
  return typeof readUid === "function" ? `${readUid.call(process)}` : "u";
}

function artifactScratchRoot(): string {
  return join(tmpdir(), `otherside-${processOwnerSegment()}`);
}

export function taskArtifactDirectory(): string {
  if (artifactState.selectedFolder !== null) return artifactState.selectedFolder;
  return join(artifactScratchRoot(), "default", `pid-${process.pid}`, "tasks");
}

function removeSelectedArtifacts(): void {
  const folder = artifactState.selectedFolder;
  if (folder === null || !folder.startsWith(`${artifactScratchRoot()}${sep}`)) return;
  try {
    rmSync(folder, { recursive: true, force: true });
  } catch {}
}

function exitAfterCleanup(status: number): void {
  removeSelectedArtifacts();
  process.exit(status);
}

function installArtifactCleanup(): void {
  if (artifactState.cleanupReady) return;
  artifactState.cleanupReady = true;
  process.on("exit", removeSelectedArtifacts);
  process.on("SIGINT", () => exitAfterCleanup(130));
  process.on("SIGTERM", () => exitAfterCleanup(143));
}

function filesystemToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function setTaskOutputSession(opts: { sessionId: string; cwd: string }): void {
  artifactState.selectedSession = opts.sessionId;
  const folderSession = filesystemToken(opts.sessionId) || "session";
  artifactState.selectedFolder = join(
    artifactScratchRoot(),
    projectSlug(opts.cwd),
    folderSession,
    "tasks",
  );
  installArtifactCleanup();
}

function rememberTaskFolder(taskId: string): string {
  const knownFolder = artifactState.taskHomes.get(taskId);
  if (knownFolder !== undefined) return knownFolder;
  const assignedFolder = taskArtifactDirectory();
  artifactState.taskHomes.set(taskId, assignedFolder);
  return assignedFolder;
}

export function resetTaskOutputPathPins(): void {
  artifactState.taskHomes.clear();
}

export function resolveTaskLogPath(taskId: string): string {
  return join(rememberTaskFolder(taskId), `${filesystemToken(taskId)}.log`);
}

export type ShellStreamName = "stdout" | "stderr";

export function getTaskSpillPath(opts: { taskId: string; stream: ShellStreamName }): string {
  const stem = filesystemToken(opts.taskId);
  return join(rememberTaskFolder(opts.taskId), `${stem}.${opts.stream}.spill`);
}

function belongsToFolder(candidate: string, folder: string): boolean {
  return candidate === folder || candidate.startsWith(`${folder}${sep}`);
}

export function isTaskOutputPath(p: string): boolean {
  const candidate = normalize(p);
  if (belongsToFolder(candidate, taskArtifactDirectory())) return true;
  for (const folder of artifactState.taskHomes.values()) {
    if (belongsToFolder(candidate, folder)) return true;
  }
  return false;
}

const TASK_LOG_EXTENSION = ".log";

export function taskIdFromOutputPath(p: string): string | null {
  if (!isTaskOutputPath(p)) return null;
  const filename = basename(normalize(p));
  if (!filename.endsWith(TASK_LOG_EXTENSION)) return null;
  const taskKey = filename.slice(0, -TASK_LOG_EXTENSION.length);
  return taskKey === "" ? null : taskKey;
}

async function prepareTaskFolder(taskId: string): Promise<void> {
  await mkdir(rememberTaskFolder(taskId), { recursive: true });
}

export async function writeTaskOutput(taskId: string, content: string): Promise<string> {
  const logFile = resolveTaskLogPath(taskId);
  await prepareTaskFolder(taskId);
  await writeFile(logFile, content, "utf8");
  return logFile;
}

export async function linkTaskOutput(taskId: string, targetPath: string): Promise<void> {
  const logFile = resolveTaskLogPath(taskId);
  await prepareTaskFolder(taskId);
  try {
    await symlink(targetPath, logFile);
  } catch (failure) {
    if (readErrorTag(failure) !== "EEXIST") throw failure;
    await unlink(logFile);
    await symlink(targetPath, logFile);
  }
}

export async function writeTaskOutputIfAbsent(taskId: string, content: string): Promise<void> {
  const logFile = resolveTaskLogPath(taskId);
  await prepareTaskFolder(taskId);
  try {
    await writeFile(logFile, content, { encoding: "utf8", flag: "wx" });
  } catch (failure) {
    if (readErrorTag(failure) !== "EEXIST") throw failure;
  }
}

function readErrorTag(failure: unknown): string | null {
  if (failure === null || typeof failure !== "object" || !("code" in failure)) return null;
  return typeof failure.code === "string" ? failure.code : null;
}

const RESULT_MESSAGE_DEFAULT_CHARS = 32_000;
const RESULT_MESSAGE_MAX_CHARS = 160_000;

export function taskResultCharacterBudget(): number {
  const rawSetting = process.env.TASK_MAX_OUTPUT_LENGTH;
  if (!rawSetting) return RESULT_MESSAGE_DEFAULT_CHARS;
  const numericSetting = Number.parseInt(rawSetting, 10);
  if (!(numericSetting > 0)) return RESULT_MESSAGE_DEFAULT_CHARS;
  return numericSetting < RESULT_MESSAGE_MAX_CHARS ? numericSetting : RESULT_MESSAGE_MAX_CHARS;
}

export function taskResultArchiveBanner(taskId: string): string {
  return `[Truncated. Full output: ${resolveTaskLogPath(taskId)}]\n\n`;
}

export interface TaskResultForModel {
  textForModel: string;
  trimmedForMessage: boolean;
}

export function renderTaskResultForMessage(sourceText: string, taskId: string): TaskResultForModel {
  const characterBudget = taskResultCharacterBudget();
  if (sourceText.length <= characterBudget) {
    return { textForModel: sourceText, trimmedForMessage: false };
  }

  const archiveBanner = taskResultArchiveBanner(taskId);
  const retainedSuffix = sourceText.slice(archiveBanner.length - characterBudget);
  return { textForModel: archiveBanner.concat(retainedSuffix), trimmedForMessage: true };
}
