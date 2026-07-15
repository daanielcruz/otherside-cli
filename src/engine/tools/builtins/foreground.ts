import type { OutputProgress } from "@/engine/tools/_infra/spill-buffer.ts";
import { recoverCwdIfMissing } from "@/engine/tools/builtins/cwd.ts";
import {
  BASH_PROGRESS_INTERVAL_MS,
  BASH_PROGRESS_TAIL_LINES,
  BASH_PROGRESS_THRESHOLD_MS,
  drainStreamToString,
  formatElapsed,
  fullTextProgress,
  killProcessTree,
  scheduleKillEscalation,
  spawnShell,
} from "@/engine/tools/builtins/exec.ts";
import { capHeadCombined } from "@/engine/tools/builtins/output.ts";
import { getTrackedCwd } from "@/kernel/std/state/cwd-state.ts";
import { formatBytes, formatDuration } from "@/kernel/std/text/format.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export interface ForegroundResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutRaw: string;
  stderrRaw: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  elapsedMs: number;
}

export function makeBashProgressSink(
  sink: RequestContext["progressSink"],
  timeoutMs: number,
): ((progress: OutputProgress) => void) | undefined {
  if (!sink) return undefined;
  const startedAt = Date.now();
  let lastEmit = 0;
  const timeoutLabel = formatDuration(timeoutMs).replace(/ 0s$/, "");
  return (progress) => {
    const now = Date.now();
    if (now - startedAt < BASH_PROGRESS_THRESHOLD_MS) return;
    if (now - lastEmit < BASH_PROGRESS_INTERVAL_MS) return;
    lastEmit = now;
    const elapsed = formatElapsed(now - startedAt);
    const trimmedTail = progress.tailText.replace(/\n+$/, "");
    if (progress.spilledChars === 0 && trimmedTail === "") {
      sink({ kind: "text", text: `Running… (${elapsed} · timeout ${timeoutLabel})` });
      return;
    }
    const tailLines = trimmedTail.split("\n");
    const lineCount = progress.spilledNewlines + tailLines.length;
    const bytes = progress.spilledChars + Buffer.byteLength(progress.tailText);
    const tail = tailLines.slice(-BASH_PROGRESS_TAIL_LINES).join("\n");
    const status = `(${elapsed} · ${lineCount} line${lineCount === 1 ? "" : "s"} · ${formatBytes(bytes)} · timeout ${timeoutLabel})`;
    sink({ kind: "text", text: `${tail}\n${status}` });
  };
}

export async function runForeground(
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
  onStdout?: (progress: OutputProgress) => void,
  login?: boolean | undefined,
): Promise<ForegroundResult> {
  recoverCwdIfMissing();
  const start = Date.now();
  const child = spawnShell(command, { cwd: getTrackedCwd(), login });

  let timedOut = false;
  let aborted = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  const terminate = (): void => {
    if (forceKillTimer !== null) return;
    killProcessTree(child, "SIGTERM");
    forceKillTimer = scheduleKillEscalation(child);
  };
  const abort = (): void => {
    aborted = true;
    terminate();
  };
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let progressTicker: ReturnType<typeof setInterval> | null = null;
  let abortListenerAttached = false;
  let stdoutText = "";
  let stderrText = "";
  let exit: number | null | undefined;
  try {
    if (signal) {
      signal.addEventListener("abort", abort, { once: true });
      abortListenerAttached = true;
      if (signal.aborted && !aborted) abort();
    }
    killTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);

    const exited: Promise<number | null> = child.exited.then((c) =>
      typeof c === "number" ? c : null,
    );
    let latestProgress: OutputProgress = { tailText: "", spilledChars: 0, spilledNewlines: 0 };
    const onStdoutTracked = onStdout
      ? (acc: string) => {
          latestProgress = fullTextProgress(acc);
          onStdout(latestProgress);
        }
      : undefined;
    progressTicker = onStdout
      ? setInterval(() => onStdout(latestProgress), BASH_PROGRESS_INTERVAL_MS)
      : null;
    [stdoutText, stderrText, exit] = await Promise.all([
      drainStreamToString(child.stdout, exited, onStdoutTracked),
      drainStreamToString(child.stderr, exited),
      child.exited,
    ]);
  } catch (error) {
    if (child.exitCode === null) terminate();
    throw error;
  } finally {
    if (progressTicker) clearInterval(progressTicker);
    if (killTimer) clearTimeout(killTimer);
    // The escalation owns its lifecycle: clearing it before child.exited can orphan the process.
    if (abortListenerAttached) signal?.removeEventListener("abort", abort);
  }

  if (timedOut || aborted) {
    const notice = aborted
      ? "Interrupted by user"
      : `Command timed out after ${formatDuration(timeoutMs)}`;
    const mergedStderr = stderrText.length > 0 ? `${notice} ${stderrText}` : notice;
    const capped = capHeadCombined(stdoutText, mergedStderr);
    return {
      exitCode: typeof exit === "number" ? exit : -1,
      stdout: capped.stdout,
      stderr: capped.stderr,
      stdoutRaw: stdoutText,
      stderrRaw: mergedStderr,
      stdoutTruncated: capped.stdoutTruncated,
      stderrTruncated: capped.stderrTruncated,
      timedOut: true,
      elapsedMs: Date.now() - start,
    };
  }

  const capped = capHeadCombined(stdoutText, stderrText);
  return {
    exitCode: typeof exit === "number" ? exit : -1,
    stdout: capped.stdout,
    stderr: capped.stderr,
    stdoutRaw: stdoutText,
    stderrRaw: stderrText,
    stdoutTruncated: capped.stdoutTruncated,
    stderrTruncated: capped.stderrTruncated,
    timedOut: false,
    elapsedMs: Date.now() - start,
  };
}
