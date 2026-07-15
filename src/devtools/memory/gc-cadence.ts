import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isSystemHeapActive } from "@/devtools/memory/allocator.ts";
import { devtoolBoolean, devtoolPath } from "@/devtools/settings.ts";

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
// full collect+decommit every N ticks bounds the footprint independently of the
// proxy; the pause is sub-millisecond because the live heap stays small.
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
// `Bun.gc(true)` collects the heap but does NOT return the freed bmalloc pages to
// the OS. The optional `gcAndSweep()` phase decommits after JSC's concurrent
// collection settles.
const DECOMMIT_SETTLE_MS = 120;

function loadGcAndSweep(): (() => void) | undefined {
  try {
    const jsc = createRequire(import.meta.url)("bun:jsc") as {
      gcAndSweep?: () => void;
    };
    return typeof jsc.gcAndSweep === "function" ? jsc.gcAndSweep : undefined;
  } catch {
    return undefined;
  }
}

interface GcRuntime {
  gc?: (force: boolean) => void;
}

function gcRuntime(): GcRuntime | undefined {
  return (globalThis as { Bun?: GcRuntime }).Bun;
}

const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024));

// Last time a keystroke was observed (see notifyInteractionActivity below).
// Starts at -Infinity so a session with no recorded activity yet never reads
// as "typing" and never defers a forced sweep.
let lastActivityAt = Number.NEGATIVE_INFINITY;

// Called from the input path (prompt.tsx) on every key event so the forced
// sweep can steer clear of active typing. Takes an explicit nowMs so callers
// can inject time in tests; production callers just take the Date.now default.
export function notifyInteractionActivity(nowMs: number = Date.now()): void {
  lastActivityAt = nowMs;
}

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

// Records each experimental decommit attempt (whether gcAndSweep fired without
// throwing + the rss delta) so the "does it fire in the full bundle" question is
// answerable from OTHERSIDE_GC_DIAG. rss is a proxy only — the real reclaim is read
// externally with `footprint -p <pid>`.
function decommitDiagSink(
  nowMs: () => number,
):
  | ((rssBefore: number, rssAfter: number, durMs: number, fired: boolean, err?: string) => void)
  | null {
  const path = devtoolPath("gcDiagnostics");
  if (!path) return null;
  return (rssBefore, rssAfter, durMs, fired, err) => {
    try {
      appendFileSync(
        path,
        `${JSON.stringify({
          t: nowMs(),
          kind: "decommit",
          fired,
          dur_ms: Math.round(durMs * 100) / 100,
          rss_before_mb: mb(rssBefore),
          rss_after_mb: mb(rssAfter),
          ...(err !== undefined ? { err } : {}),
        })}\n`,
      );
    } catch {
      // best-effort diagnostics
    }
  };
}

let installed = false;

export function installGcCadence(nowMs: () => number = Date.now): void {
  if (installed || !devtoolBoolean("gcCadence")) return;
  // Under the system-heap path (any Malloc* env — see alloc-lever.ts) the
  // allocator returns freed blocks on free itself; the forced collect+decommit
  // below only scavenges the (empty) bundled-allocator zone at 85-175ms of
  // synchronous main-thread pause per fire. Measured: fires every tick under
  // the lever (rss proxy always above the gate), reclaims 0. Skip entirely.
  if (isSystemHeapActive()) return;
  const runtime = gcRuntime();
  if (typeof runtime?.gc !== "function") return;
  installed = true;
  const gc = runtime.gc;
  const diag = gcDiagSink(nowMs);
  const decommit = devtoolBoolean("gcDecommit") ? loadGcAndSweep() : undefined;
  const decommitDiag = decommit ? decommitDiagSink(nowMs) : null;
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
      lastActivityAt,
    });
    if (forced) lastForcedAt = now;
    gc(forced);
    diag?.(mem, nativeBytes, forced);
    if (forced && decommit) {
      const rssBefore = mem.rss;
      const settle = setTimeout(() => {
        const start = performance.now();
        try {
          decommit();
          decommitDiag?.(rssBefore, process.memoryUsage().rss, performance.now() - start, true);
        } catch (err) {
          decommitDiag?.(
            rssBefore,
            process.memoryUsage().rss,
            performance.now() - start,
            false,
            String(err),
          );
        }
      }, DECOMMIT_SETTLE_MS);
      settle.unref?.();
    }
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}
