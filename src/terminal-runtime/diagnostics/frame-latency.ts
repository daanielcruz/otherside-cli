import { appendFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { devtoolPath } from "@/devtools/settings.ts";

export function inputLagTraceEnabled(): boolean {
  return devtoolPath("commitLog") !== undefined;
}

export function recordInputLag(kind: string, durationMs: number): void {
  const path = devtoolPath("commitLog");
  if (!path) return;
  const ts = performance.now();
  appendFileSync(path, `${ts.toFixed(1)} SLOW_${kind.toUpperCase()} ${durationMs.toFixed(1)}ms\n`);
}

let eventLoopHistogram: ReturnType<typeof monitorEventLoopDelay> | undefined;

export function startEventLoopMonitor(): void {
  if (eventLoopHistogram || !inputLagTraceEnabled()) return;
  try {
    eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
    eventLoopHistogram.enable();
  } catch {}
}
