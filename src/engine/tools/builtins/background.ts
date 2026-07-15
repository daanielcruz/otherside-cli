import type { Subprocess } from "bun";
import {
  completeTask,
  markTaskNotified,
  SHELL_OUTPUT_TAIL_CAP,
  startShellTask,
} from "@/engine/background/tasks/background.ts";
import {
  getMaxTaskOutputLength,
  getTaskOutputPath,
  getTaskSpillPath,
} from "@/engine/background/tasks/output-files.ts";
import { startStallWatchdog } from "@/engine/background/tasks/stall-watchdog.ts";
import { SpillBuffer } from "@/engine/tools/_infra/spill-buffer.ts";
import {
  BACKGROUND_OUTPUT_LIMIT_NOTICE,
  createBackgroundOutputLimiter,
  MAX_BACKGROUND_OUTPUT_BYTES,
} from "@/engine/tools/builtins/background-output-limit.ts";
import { recoverCwdIfMissing } from "@/engine/tools/builtins/cwd.ts";
import {
  drainStream,
  killProcessTree,
  makeTaskLogAppender,
  scheduleKillEscalation,
  spawnShell,
} from "@/engine/tools/builtins/exec.ts";
import { generateTaskId } from "@/kernel/std/id.ts";
import { getTrackedCwd } from "@/kernel/std/state/cwd-state.ts";

export const MAX_CONCURRENT = 10;
const RETAINED_EXITED = 50;

export interface ShellStream {
  buffer: SpillBuffer;
  cursor: number;
}

export interface BackgroundShell {
  id: string;
  command: string;
  startedAt: number;
  stdout: ShellStream;
  stderr: ShellStream;
  status: "running" | "exited";
  exitCode: number | null;
  child: Subprocess<"ignore", "pipe", "pipe"> | null;
  ownerId?: string;
  stopOutput?: () => void;
  stopWatchdog?: () => void;
  terminate?: () => void;
}

export const SHELLS = new Map<string, BackgroundShell>();

let exitCleanupRegistered = false;

export function ensureExitCleanup(): void {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.on("exit", () => {
    for (const shell of SHELLS.values()) {
      if (shell.status === "running" && shell.child) {
        killProcessTree(shell.child, "SIGTERM");
      }
    }
  });
}

export function newShellId(): string {
  return generateTaskId("b");
}

export function newShellStreams(id: string): { stdout: ShellStream; stderr: ShellStream } {
  return {
    stdout: {
      buffer: new SpillBuffer({ path: getTaskSpillPath({ taskId: id, stream: "stdout" }) }),
      cursor: 0,
    },
    stderr: {
      buffer: new SpillBuffer({ path: getTaskSpillPath({ taskId: id, stream: "stderr" }) }),
      cursor: 0,
    },
  };
}

export function disposeShellStreams(shell: BackgroundShell): void {
  shell.stopOutput?.();
  shell.stopWatchdog?.();
  shell.stdout.buffer.dispose();
  shell.stderr.buffer.dispose();
}

export function runningShellCount(): number {
  let count = 0;
  for (const shell of SHELLS.values()) {
    if (shell.status === "running") count++;
  }
  return count;
}

export function pruneExitedShells(): void {
  const exited: string[] = [];
  for (const [id, shell] of SHELLS) {
    if (shell.status === "exited") exited.push(id);
  }
  for (let i = 0; i < exited.length - RETAINED_EXITED; i++) {
    const id = exited[i];
    if (id === undefined) continue;
    const shell = SHELLS.get(id);
    if (shell) disposeShellStreams(shell);
    SHELLS.delete(id);
  }
}

interface SpawnBackgroundInput {
  execCommand: string;
  command: string;
  displayCommand: string;
  parentToolCallId: string;
  isSidechain?: boolean;
  ownerId?: string;
  login?: boolean | undefined;
}

export function spawnBackground(input: SpawnBackgroundInput): { id: string } | { error: string } {
  if (runningShellCount() >= MAX_CONCURRENT) {
    return { error: `background shell cap reached (${MAX_CONCURRENT} concurrent)` };
  }
  recoverCwdIfMissing();
  ensureExitCleanup();
  const child = spawnShell(input.execCommand, { cwd: getTrackedCwd(), login: input.login });
  const id = newShellId();
  const shell: BackgroundShell = {
    id,
    command: input.displayCommand,
    startedAt: Date.now(),
    ...newShellStreams(id),
    status: "running",
    exitCode: null,
    child,
    ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
  };
  SHELLS.set(id, shell);
  startShellTask({
    shellId: id,
    command: input.command,
    displayCommand: input.displayCommand,
    parentToolCallId: input.parentToolCallId,
    ...(input.isSidechain ? { isSidechain: true } : {}),
    ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
    startedAt: shell.startedAt,
  });
  const stopStallWatchdog = startStallWatchdog({ taskId: id, toolUseId: input.parentToolCallId });
  shell.stopWatchdog = stopStallWatchdog;
  const log = makeTaskLogAppender(getTaskOutputPath(id));
  let outputOpen = true;
  let terminationRequested = false;
  let outputClosed = false;
  const stopOutput = (): void => {
    outputOpen = false;
    if (outputClosed) return;
    outputClosed = true;
    log.close();
  };
  const terminate = (): void => {
    if (terminationRequested) return;
    terminationRequested = true;
    killProcessTree(child, "SIGTERM");
    scheduleKillEscalation(child);
  };
  const acceptChunk = createBackgroundOutputLimiter({
    maxBytes: MAX_BACKGROUND_OUTPUT_BYTES,
    onExceeded: () => {
      if (!outputOpen) return;
      shell.stderr.buffer.append(BACKGROUND_OUTPUT_LIMIT_NOTICE);
      log.queueChunk(`\n${BACKGROUND_OUTPUT_LIMIT_NOTICE}\n`);
      terminate();
    },
  });
  shell.stopOutput = stopOutput;
  shell.terminate = terminate;
  const stdoutDrain = drainStream(child.stdout, {
    buffer: shell.stdout.buffer,
    onChunk: log.queueChunk,
    acceptChunk: (chunk) => outputOpen && acceptChunk(chunk),
    childExited: child.exited,
  });
  const stderrDrain = drainStream(child.stderr, {
    buffer: shell.stderr.buffer,
    onChunk: log.queueChunk,
    acceptChunk: (chunk) => outputOpen && acceptChunk(chunk),
    childExited: child.exited,
  });
  void child.exited.then(async (code) => {
    stopStallWatchdog();
    delete shell.stopWatchdog;
    await Promise.allSettled([stdoutDrain, stderrDrain]);
    stopOutput();
    shell.status = "exited";
    shell.exitCode = typeof code === "number" ? code : -1;
    const exit = typeof code === "number" ? code : -1;
    const content = boundedCompletionContent(shell);
    completeTask(id, {
      content: content.length > 0 ? content : `(exit ${exit})`,
      isError: exit !== 0,
      exitCode: exit,
    });
    pruneExitedShells();
  });
  return { id };
}

// Stores at most the TaskOutput display cap on the task record, pre-shaped
// exactly as formatTaskOutput would emit, so the read path returns identical
// bytes without the store ever holding the full output. The full text already
// streams to the task .log during the run — the header points there. The
// in-memory tails (256k each) always cover the cap (≤160k), so nothing is
// read back from the spill files.
function boundedCompletionContent(shell: BackgroundShell): string {
  const totalLength = shell.stdout.buffer.length + shell.stderr.buffer.length;
  const maxLen = getMaxTaskOutputLength();
  if (totalLength <= maxLen) {
    return shell.stdout.buffer.snapshot() + shell.stderr.buffer.snapshot();
  }
  const header = `[Truncated. Full output: ${getTaskOutputPath(shell.id)}]\n\n`;
  const tail = (shell.stdout.buffer.memoryTail() + shell.stderr.buffer.memoryTail()).slice(
    -(maxLen - header.length),
  );
  return `${header}${tail}`;
}

export interface BashSummary {
  id: string;
  command: string;
  status: "running" | "exited";
  exitCode: number | null;
  startedAt: number;
}

export function listBackground(): BashSummary[] {
  return [...SHELLS.entries()].map(([id, s]) => ({
    id,
    command: s.command,
    status: s.status,
    exitCode: s.exitCode,
    startedAt: s.startedAt,
  }));
}

export function pollBackground(
  shellId: string,
  filter: string | null,
): { stdout: string; stderr: string; status: string; exitCode: number | null } | { error: string } {
  const shell = SHELLS.get(shellId);
  if (!shell) return { error: `no background shell \`${shellId}\`` };
  const drainNew = (s: ShellStream): string => {
    const end = s.buffer.length;
    if (s.cursor >= end) return "";
    const out = s.buffer.readFrom(s.cursor, SHELL_OUTPUT_TAIL_CAP);
    s.cursor = end;
    return out;
  };
  const filterLines = (s: string): string => {
    if (filter == null) return s;
    return s
      .split("\n")
      .filter((l) => l.includes(filter))
      .map((l) => `${l}\n`)
      .join("");
  };
  return {
    stdout: filterLines(drainNew(shell.stdout)),
    stderr: filterLines(drainNew(shell.stderr)),
    status: shell.status,
    exitCode: shell.exitCode,
  };
}

export function killBackground(shellId: string): { ok: true } | { error: string } {
  const shell = SHELLS.get(shellId);
  if (!shell) return { error: `no background shell \`${shellId}\`` };
  SHELLS.delete(shellId);
  const terminate = shell.terminate;
  shell.stopOutput?.();
  shell.stopWatchdog?.();
  if (shell.child) {
    if (terminate) terminate();
    else {
      killProcessTree(shell.child, "SIGTERM");
      scheduleKillEscalation(shell.child);
    }
  }
  shell.status = "exited";
  disposeShellStreams(shell);
  return { ok: true };
}

export function killShellsForOwner(ownerId: string): number {
  let killed = 0;
  for (const [id, shell] of [...SHELLS.entries()]) {
    if (shell.ownerId !== ownerId) continue;
    SHELLS.delete(id);
    const terminate = shell.terminate;
    shell.stopOutput?.();
    shell.stopWatchdog?.();
    disposeShellStreams(shell);
    if (shell.status !== "running") continue;
    markTaskNotified(id);
    completeTask(id, {
      content: "(killed: owning agent finished)",
      isError: false,
      killed: true,
    });
    if (shell.child) {
      if (terminate) terminate();
      else {
        killProcessTree(shell.child, "SIGTERM");
        scheduleKillEscalation(shell.child);
      }
    }
    shell.status = "exited";
    killed++;
  }
  return killed;
}
