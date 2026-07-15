import { completeTask, startShellTask } from "@/engine/background/tasks/background.ts";
import { startStallWatchdog } from "@/engine/background/tasks/stall-watchdog.ts";
import type { OutputProgress, SpillBuffer } from "@/engine/tools/_infra/spill-buffer.ts";
import {
  type BackgroundShell,
  disposeShellStreams,
  ensureExitCleanup,
  MAX_CONCURRENT,
  newShellId,
  newShellStreams,
  pruneExitedShells,
  runningShellCount,
  SHELLS,
} from "@/engine/tools/builtins/background.ts";
import {
  BACKGROUND_OUTPUT_LIMIT_NOTICE,
  createBackgroundOutputLimiter,
  MAX_BACKGROUND_OUTPUT_BYTES,
} from "@/engine/tools/builtins/background-output-limit.ts";
import { cleanupCwdFile, recoverCwdIfMissing } from "@/engine/tools/builtins/cwd.ts";
import {
  BASH_PROGRESS_INTERVAL_MS,
  drainStream,
  killProcessTree,
  scheduleKillEscalation,
  spawnShell,
} from "@/engine/tools/builtins/exec.ts";
import { runForeground } from "@/engine/tools/builtins/foreground.ts";
import {
  bashOutputCap,
  capHeadCombined,
  truncationMarker,
} from "@/engine/tools/builtins/output.ts";
import { isAutoBackgroundableCommand } from "@/engine/tools/builtins/safety.ts";
import { getTrackedCwd } from "@/kernel/std/state/cwd-state.ts";
import { formatDuration } from "@/kernel/std/text/format.ts";

const PROMOTED_RESULT_TAIL_CHARS = 2_000;

// Exit-time read matching the foreground drain's bounds: full text up to
// cap*4 code units, otherwise head (cap*2) + marker + tail (cap). Never
// re-materializes the whole spill file.
function boundedStreamText(buffer: SpillBuffer): string {
  const cap = bashOutputCap();
  const parts = buffer.boundedSnapshot(cap * 2, cap);
  if (!parts.truncated) return parts.head;
  return parts.head + truncationMarker(parts.discardedBytes) + parts.tail;
}

export interface AutoBgOutcome {
  promoted: true;
  shellId: string;
  reason: string;
}

export interface AutoBgEligibleSpawn {
  promoted: false;
  result: {
    exitCode: number;
    stdout: string;
    stderr: string;
    stdoutRaw: string;
    stderrRaw: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    timedOut: boolean;
    elapsedMs: number;
  };
}

export async function runForegroundWithAutoBg(opts: {
  command: string;
  displayCommand: string;
  parentToolCallId: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  userBgSignaled?: Promise<void> | undefined;
  isSidechain?: boolean;
  ownerId?: string;
  onStdout?: (progress: OutputProgress) => void;
  originalCommand?: string;
  cwdFilePath?: string | null;
  login?: boolean | undefined;
}): Promise<AutoBgOutcome | AutoBgEligibleSpawn> {
  const originalCommand = opts.originalCommand ?? opts.command;
  const classifierEligible = isAutoBackgroundableCommand(originalCommand);
  const hasUserBgSignal = opts.userBgSignaled !== undefined;
  if (!classifierEligible && !hasUserBgSignal) {
    const result = await runForeground(
      opts.command,
      opts.timeoutMs,
      opts.signal,
      opts.onStdout,
      opts.login,
    );
    return { promoted: false, result };
  }
  if (runningShellCount() >= MAX_CONCURRENT) {
    const result = await runForeground(
      opts.command,
      opts.timeoutMs,
      opts.signal,
      opts.onStdout,
      opts.login,
    );
    return { promoted: false, result };
  }
  recoverCwdIfMissing();
  const start = Date.now();
  const child = spawnShell(opts.command, { cwd: getTrackedCwd(), login: opts.login });
  const shellId = newShellId();
  const shell: BackgroundShell = {
    id: shellId,
    command: opts.displayCommand,
    startedAt: start,
    ...newShellStreams(shellId),
    status: "running",
    exitCode: null,
    child,
    ...(opts.ownerId !== undefined ? { ownerId: opts.ownerId } : {}),
  };
  const onStdout = opts.onStdout;
  let outputOpen = true;
  let outputLimited = false;
  let terminationRequested = false;
  const terminate = (): void => {
    if (terminationRequested) return;
    terminationRequested = true;
    killProcessTree(child, "SIGTERM");
    scheduleKillEscalation(child);
  };
  const stopOutput = (): void => {
    outputOpen = false;
  };
  const acceptChunk = createBackgroundOutputLimiter({
    maxBytes: MAX_BACKGROUND_OUTPUT_BYTES,
    onExceeded: () => {
      if (!outputOpen) return;
      outputLimited = true;
      shell.stderr.buffer.append(BACKGROUND_OUTPUT_LIMIT_NOTICE);
      terminate();
    },
  });
  shell.stopOutput = stopOutput;
  shell.terminate = terminate;
  const stdoutDrain = drainStream(child.stdout, {
    buffer: shell.stdout.buffer,
    ...(onStdout ? { onChunk: () => onStdout(shell.stdout.buffer.progress()) } : {}),
    acceptChunk: (chunk) => outputOpen && acceptChunk(chunk),
    childExited: child.exited,
  });
  const stderrDrain = drainStream(child.stderr, {
    buffer: shell.stderr.buffer,
    acceptChunk: (chunk) => outputOpen && acceptChunk(chunk),
    childExited: child.exited,
  });
  const progressTicker = onStdout
    ? setInterval(() => {
        if (outputOpen) onStdout(shell.stdout.buffer.progress());
      }, BASH_PROGRESS_INTERVAL_MS)
    : null;
  let aborted = false;
  const abort = (): void => {
    aborted = true;
    terminate();
  };
  if (opts.signal?.aborted) abort();
  else opts.signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  let resolveTimeoutPromotion: () => void = () => {};
  const races: Promise<"exit" | "promote" | "user">[] = [
    child.exited.then(() => "exit" as const),
    new Promise<"promote">((resolve) => {
      resolveTimeoutPromotion = () => resolve("promote");
    }),
  ];
  const killTimer = setTimeout(() => {
    if (classifierEligible) {
      resolveTimeoutPromotion();
      return;
    }
    timedOut = true;
    terminate();
  }, opts.timeoutMs);
  if (opts.userBgSignaled) {
    races.push(opts.userBgSignaled.then(() => "user" as const));
  }
  const verdict = await Promise.race(races);
  if ((verdict === "promote" || verdict === "user") && !timedOut && !aborted && !outputLimited) {
    clearTimeout(killTimer);
    if (progressTicker) clearInterval(progressTicker);
    opts.signal?.removeEventListener("abort", abort);
    ensureExitCleanup();
    SHELLS.set(shellId, shell);
    startShellTask({
      shellId,
      command: originalCommand,
      displayCommand: opts.displayCommand,
      parentToolCallId: opts.parentToolCallId,
      ...(opts.isSidechain ? { isSidechain: true } : {}),
      ...(opts.ownerId !== undefined ? { ownerId: opts.ownerId } : {}),
      startedAt: shell.startedAt,
    });
    const stopStallWatchdog = startStallWatchdog({
      taskId: shellId,
      toolUseId: opts.parentToolCallId,
    });
    shell.stopWatchdog = stopStallWatchdog;
    void child.exited.then(async (code) => {
      stopStallWatchdog();
      delete shell.stopWatchdog;
      await Promise.allSettled([stdoutDrain, stderrDrain]);
      stopOutput();
      shell.status = "exited";
      shell.exitCode = typeof code === "number" ? code : -1;
      const exit = typeof code === "number" ? code : -1;
      const tail = (shell.stdout.buffer.memoryTail() + shell.stderr.buffer.memoryTail()).slice(
        -PROMOTED_RESULT_TAIL_CHARS,
      );
      completeTask(shellId, {
        content: tail.length > 0 ? tail : `(exit ${exit})`,
        isError: exit !== 0,
        exitCode: exit,
      });
      pruneExitedShells();
      cleanupCwdFile(opts.cwdFilePath ?? null);
    });
    const reason =
      verdict === "user"
        ? `user pressed Ctrl+B; command moved to background, use TaskOutput #${shellId} to read live output`
        : `command exceeded its ${Math.round(opts.timeoutMs / 1000)}s timeout and was moved to the background instead of being killed; use TaskOutput #${shellId} to read live output`;
    return {
      promoted: true,
      shellId,
      reason,
    };
  }
  const exitFromChild = await child.exited;
  clearTimeout(killTimer);
  if (progressTicker) clearInterval(progressTicker);
  opts.signal?.removeEventListener("abort", abort);
  await Promise.all([stdoutDrain, stderrDrain]);
  const numericExit = typeof exitFromChild === "number" ? exitFromChild : -1;
  stopOutput();
  shell.exitCode = numericExit;
  const exitCode = aborted ? -1 : numericExit;
  const stdoutText = boundedStreamText(shell.stdout.buffer);
  const realStderr = boundedStreamText(shell.stderr.buffer);
  const notice = outputLimited
    ? BACKGROUND_OUTPUT_LIMIT_NOTICE
    : aborted
      ? "Interrupted by user"
      : timedOut
        ? `Command timed out after ${formatDuration(opts.timeoutMs)}`
        : null;
  const stderrText = outputLimited
    ? realStderr
    : notice
      ? realStderr.length > 0
        ? `${notice} ${realStderr}`
        : notice
      : realStderr;
  disposeShellStreams(shell);
  const capped = capHeadCombined(stdoutText, stderrText);
  return {
    promoted: false,
    result: {
      exitCode,
      stdout: capped.stdout,
      stderr: capped.stderr,
      stdoutRaw: stdoutText,
      stderrRaw: stderrText,
      stdoutTruncated: capped.stdoutTruncated,
      stderrTruncated: capped.stderrTruncated,
      timedOut,
      elapsedMs: Date.now() - start,
    },
  };
}
