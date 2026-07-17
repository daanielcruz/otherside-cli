import { appendFileSync } from "node:fs";
import { isSystemHeapActive } from "@/devtools/memory/allocator.ts";
import { devtoolBoolean, devtoolPath } from "@/devtools/settings.ts";
import { lastInteractionTime } from "@/kernel/std/state/interaction-clock.ts";

// JSC never runs a full collection on its own under sustained turn activity:
// the JS heap stays small while dead string backing buffers pile up in the
// native (bmalloc) zone — measured 7.5GB/h growth with heap_used flat and
// `leaks` reporting ~64 bytes. An explicit Bun.gc sweep returns that memory
// immediately (841MB → 522MB measured), so a periodic sweep bounds the
// footprint. Pause cost is sub-millisecond even on a ~120MB heap.
const SWEEP_INTERVAL_MS = 1_000;
const FORCED_SWEEP_NATIVE_BYTES = 300 * 1024 * 1024;
// macOS compresses cold bmalloc pages, shrinking `rss` while phys_footprint keeps
// ratcheting — the native-bytes proxy then starves the forced path exactly when
// the leak is worst (observed: rss 405MB vs footprint 7.7GB). An unconditional
// full collect every N ticks bounds the footprint independently of the proxy;
// the pause is sub-millisecond because the live heap stays small.
const UNCONDITIONAL_SWEEP_TICKS = 30;
// A long-lived session sits with rss - heapUsed permanently above the forced
// threshold, so the naive gate fires every single tick and every keystroke has
// a chance to land inside an 85-175ms synchronous gc(true) pause (measured
// typing-lag regression). These three constants throttle the forced path to
// stay out of active typing while keeping the 30s worst-case memory bound.
// Hysteresis: once a forced sweep fires, the proxy-driven path may not force
// again for this long.
const FORCED_SWEEP_MIN_GAP_MS = 10_000;
// A keystroke within this window defers a forced sweep that would otherwise fire.
const ACTIVITY_QUIET_MS = 3_000;
// Typing may defer a due forced sweep at most this long — matches the existing
// unconditional 30-tick cadence, so the memory bound is unchanged.
const MAX_FORCED_DEFER_MS = 30_000;

interface GcRuntime {
  gc?: (force: boolean) => void;
}

function gcRuntime(): GcRuntime | undefined {
  return (globalThis as { Bun?: GcRuntime }).Bun;
}

const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024));

// The keystroke clock is production state (kernel interaction-clock); this
// diagnostic only reads it so forced sweeps steer clear of active typing.
// The input path (prompt.tsx) still imports the historical name from here.
export { noteInteraction as notifyInteractionActivity } from "@/kernel/std/state/interaction-clock.ts";

// Pure decision for whether a tick should run the forced (synchronous,
// 85-175ms) collect vs. the cheap gc(false). Kept free of globals/timers so
// it is unit-testable: the naive "over threshold or every Nth tick" gate is
// what caused the typing-lag regression (fires every second in a long-lived
// session), so this adds hysteresis (FORCED_SWEEP_MIN_GAP_MS), a typing quiet
// window (ACTIVITY_QUIET_MS), and an overdue override (MAX_FORCED_DEFER_MS) so
// the 30s worst-case memory bound still holds even under continuous typing.
export function shouldForceSweep(input: {
  nativeBytes: number;
  tick: number;
  nowMs: number;
  lastForcedAt: number;
  lastActivityAt: number;
}): boolean {
  const { nativeBytes, tick, nowMs, lastForcedAt, lastActivityAt } = input;
  const wanted = nativeBytes > FORCED_SWEEP_NATIVE_BYTES || tick % UNCONDITIONAL_SWEEP_TICKS === 0;
  if (!wanted) return false;
  const inGap = nowMs - lastForcedAt < FORCED_SWEEP_MIN_GAP_MS;
  if (inGap) return false;
  const typing = nowMs - lastActivityAt < ACTIVITY_QUIET_MS;
  const overdue = nowMs - lastForcedAt >= MAX_FORCED_DEFER_MS;
  return !typing || overdue;
}

// One JSONL sample of the forced-sweep decision. `native_mb` (rss - heapUsed) is
// the proxy the trigger gates on; it can UNDER-report vs the OS `phys_footprint`
// when macOS compresses the bmalloc zone, so the diag exists to correlate this
// series against an external `footprint <pid>` sample before tuning the ratio.
export function formatGcDiagLine(
  mem: { rss: number; heapUsed: number },
  nativeBytes: number,
  forced: boolean,
  nowMs: number,
): string {
  return JSON.stringify({
    t: nowMs,
    rss_mb: mb(mem.rss),
    heap_mb: mb(mem.heapUsed),
    native_mb: mb(nativeBytes),
    forced,
  });
}

function gcDiagSink(
  nowMs: () => number,
): ((mem: NodeJS.MemoryUsage, native: number, forced: boolean) => void) | null {
  const path = devtoolPath("gcDiagnostics");
  if (!path) return null;
  return (mem, native, forced) => {
    try {
      appendFileSync(path, `${formatGcDiagLine(mem, native, forced, nowMs())}\n`);
    } catch {
      // best-effort diagnostics; never let logging break the sweep
    }
  };
}

let installed = false;

export function installGcCadence(nowMs: () => number = Date.now): void {
  if (installed || !devtoolBoolean("gcCadence")) return;
  // Under the system-heap path (any Malloc* env — see alloc-lever.ts) the
  // allocator returns freed blocks on free itself; the forced collect below
  // only scavenges the (empty) bundled-allocator zone at 85-175ms of
  // synchronous main-thread pause per fire. Measured: fires every tick under
  // the lever (rss proxy always above the gate), reclaims 0. Skip entirely.
  if (isSystemHeapActive()) return;
  const runtime = gcRuntime();
  if (typeof runtime?.gc !== "function") return;
  installed = true;
  const gc = runtime.gc;
  const diag = gcDiagSink(nowMs);
  let tick = 0;
  let lastForcedAt = Number.NEGATIVE_INFINITY;
  const timer = setInterval(() => {
    tick += 1;
    const mem = process.memoryUsage();
    const nativeBytes = mem.rss - mem.heapUsed;
    const now = nowMs();
    const forced = shouldForceSweep({
      nativeBytes,
      tick,
      nowMs: now,
      lastForcedAt,
      lastActivityAt: lastInteractionTime(),
    });
    if (forced) lastForcedAt = now;
    gc(forced);
    diag?.(mem, nativeBytes, forced);
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}
