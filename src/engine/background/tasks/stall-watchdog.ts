import { emitQueue } from "@/engine/queue/emit.ts";
import { get } from "./background.ts";
import { buildStallNotification } from "./notification.ts";
import { resolveTaskLogPath } from "./output-files.ts";

const OBSERVATION_PERIOD_MS = 5_000;
const QUIET_PERIOD_MS = 45_000;
const INSPECTION_SUFFIX_LENGTH = 1024;

const INTERACTIVE_LAST_LINE_SIGNALS = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\(yes\/no\)/i,
  /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
  /Press (any key|Enter)/i,
  /Continue\?/i,
  /Overwrite\?/i,
];

let notificationSequence = 0;

export function finalLineRequestsInput(outputSuffix: string): boolean {
  const finalLine = outputSuffix.trimEnd().split("\n").at(-1) ?? "";
  return INTERACTIVE_LAST_LINE_SIGNALS.some((signal) => signal.test(finalLine));
}

export interface StallWatchdogTimerApi {
  setInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

export interface StallWatchdogOptions {
  taskId: string;
  toolUseId?: string;
  intervalMs?: number;
  thresholdMs?: number;
  now?: () => number;
  timerApi?: StallWatchdogTimerApi;
}

const systemTimerApi: StallWatchdogTimerApi = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (timer) => clearInterval(timer),
};

function detachFromProcessLifetime(timer: ReturnType<typeof setInterval>): void {
  const detachable = timer as { unref?: () => void };
  detachable.unref?.();
}

function emitInteractiveWait(
  task: NonNullable<ReturnType<typeof get>>,
  toolUseId: string | undefined,
  outputSuffix: string,
): void {
  const description = task.description ?? task.agentName;
  const summary = `Background command "${description}" appears to be waiting for interactive input`;
  const text = buildStallNotification({
    taskId: task.id,
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    outputFile: resolveTaskLogPath(task.id),
    summary,
    tail: outputSuffix,
  });
  notificationSequence += 1;
  emitQueue.emit({
    class: "urgent_output",
    target: "both",
    payload: { kind: "task_notification_xml", text, summary },
    replayKey: `stall:${task.id}:${notificationSequence}`,
  });
}

export function watchForInteractiveWait(options: StallWatchdogOptions): () => void {
  const clock = options.now ?? Date.now;
  const timers = options.timerApi ?? systemTimerApi;
  const observationPeriod = options.intervalMs ?? OBSERVATION_PERIOD_MS;
  const quietPeriod = options.thresholdMs ?? QUIET_PERIOD_MS;

  let greatestObservedLength = 0;
  let quietPeriodStartedAt = clock();
  let monitoring = true;
  let timer: ReturnType<typeof setInterval>;

  const inspectTask = (): void => {
    if (!monitoring) return;

    const task = get(options.taskId);
    if (task === undefined || task.status !== "running" || task.notified) return;

    const output = task.shellOutput;
    if (output.length > greatestObservedLength) {
      greatestObservedLength = output.length;
      quietPeriodStartedAt = clock();
      return;
    }

    if (clock() - quietPeriodStartedAt < quietPeriod) return;

    const outputSuffix = output.slice(-INSPECTION_SUFFIX_LENGTH);
    if (!finalLineRequestsInput(outputSuffix)) {
      quietPeriodStartedAt = clock();
      return;
    }

    monitoring = false;
    timers.clearInterval(timer);
    emitInteractiveWait(task, options.toolUseId, outputSuffix);
  };

  timer = timers.setInterval(inspectTask, observationPeriod);
  detachFromProcessLifetime(timer);

  return (): void => {
    monitoring = false;
    timers.clearInterval(timer);
  };
}
