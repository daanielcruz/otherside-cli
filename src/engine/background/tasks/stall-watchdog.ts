import { emitQueue } from "@/engine/queue/emit.ts";
import { get } from "./background.ts";
import { buildStallNotification } from "./notification.ts";
import { getTaskOutputPath } from "./output-files.ts";

let stallEpoch = 0;

const STALL_CHECK_INTERVAL_MS = 5_000;
const STALL_THRESHOLD_MS = 45_000;
const STALL_TAIL_BYTES = 1024;

const PROMPT_PATTERNS = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\(yes\/no\)/i,
  /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
  /Press (any key|Enter)/i,
  /Continue\?/i,
  /Overwrite\?/i,
];

export function looksLikePrompt(tail: string): boolean {
  const lastLine = tail.trimEnd().split("\n").pop() ?? "";
  return PROMPT_PATTERNS.some((p) => p.test(lastLine));
}

export interface StallWatchdogOptions {
  taskId: string;
  toolUseId?: string;
  intervalMs?: number;
  thresholdMs?: number;
  now?: () => number;
}

export function startStallWatchdog(opts: StallWatchdogOptions): () => void {
  const interval = opts.intervalMs ?? STALL_CHECK_INTERVAL_MS;
  const threshold = opts.thresholdMs ?? STALL_THRESHOLD_MS;
  const now = opts.now ?? (() => Date.now());

  let lastSize = 0;
  let lastGrowth = now();
  let cancelled = false;

  const tick = (): void => {
    if (cancelled) return;
    const task = get(opts.taskId);
    if (!task) return;
    if (task.status !== "running") return;
    if (task.notified) return;
    const buffer = task.shellOutput;
    const size = buffer.length;
    if (size > lastSize) {
      lastSize = size;
      lastGrowth = now();
      return;
    }
    if (now() - lastGrowth < threshold) return;
    const tail = buffer.slice(-STALL_TAIL_BYTES);
    if (!looksLikePrompt(tail)) {
      lastGrowth = now();
      return;
    }
    cancelled = true;
    clearInterval(timer);
    const description = task.description ?? task.agentName;
    const summary = `Background command "${description}" appears to be waiting for interactive input`;
    const notificationText = buildStallNotification({
      taskId: task.id,
      ...(opts.toolUseId !== undefined ? { toolUseId: opts.toolUseId } : {}),
      outputFile: getTaskOutputPath(task.id),
      summary,
      tail,
    });
    stallEpoch += 1;
    emitQueue.emit({
      class: "urgent_output",
      target: "both",
      payload: { kind: "task_notification_xml", text: notificationText, summary },
      replayKey: `stall:${task.id}:${stallEpoch}`,
    });
  };

  const timer = setInterval(tick, interval);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  return () => {
    cancelled = true;
    clearInterval(timer);
  };
}
