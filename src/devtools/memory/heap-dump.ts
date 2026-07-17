import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import * as v8 from "node:v8";
import { devtoolBoolean, devtoolNumber, devtoolPath } from "@/devtools/settings.ts";
import { OTHERSIDE_VERSION } from "@/engine/session/record/state.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";

// Debug-only heap/memory instrument. Fully OFF unless OTHERSIDE_DEBUG_HEAPDUMP is
// set — it characterizes a growing-RSS session (which accumulator: JS heap vs
// native/sockets vs allocator-retained pages) instead of guessing. Off by
// default it adds nothing to a normal run.
//
// When enabled it:
//   - dumps a V8 heap snapshot + diagnostics JSON on SIGUSR2 (manual) and when
//     RSS crosses OTHERSIDE_HEAPDUMP_AUTO_MB (threshold);
//   - toggles a CPU sampling profile on SIGUSR1 (bracket a window manually), and
//     when OTHERSIDE_CPUPROFILE_SEC is set, profiles continuously in chunks of
//     that many seconds (each chunk its own .cpuprofile, so a kill mid-run loses
//     only the last chunk, not the whole capture);
//   - appends a periodic RSS/handle timeseries to heap-rss.jsonl.
// .heapsnapshot loads in Chrome DevTools Memory (retainer tree); .cpuprofile loads
// in DevTools Performance (flame chart) — together they localize WHERE the RSS and
// CPU go. The diagnostics JSON carries leak heuristics.

export type HeapDumpTrigger = "manual" | "signal" | "threshold";

const HIGH_ACTIVE_HANDLES = 100;
const HIGH_OPEN_FDS = 500;
const HIGH_GROWTH_MB_PER_HOUR = 100;
const BYTES_PER_MB = 1024 * 1024;

export function heapDumpDir(): string {
  const base = devtoolPath("debugLogDir") ?? join(configRoot(), "debug");
  return join(base, "heap");
}

export interface HeapDiagnostics {
  timestamp: string;
  trigger: HeapDumpTrigger;
  uptimeSeconds: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  nativeBytes: number;
  heapSizeLimit: number | undefined;
  mallocedMemory: number | undefined;
  peakMallocedMemory: number | undefined;
  detachedContexts: number | undefined;
  nativeContexts: number | undefined;
  activeHandles: number;
  activeRequests: number;
  openFileDescriptors: number | undefined;
  bytesPerSecond: number;
  approxMbPerHour: number;
  heapSpaces: Array<{ name: string; size: number; used: number; available: number }> | undefined;
  resourceUsage: { maxRSS: number; userCPUTime: number; systemCPUTime: number } | undefined;
  smapsRollup: string | undefined;
  objectTypeCounts: Record<string, number> | undefined;
  protectedObjectTypeCounts: Record<string, number> | undefined;
  mimalloc: unknown;
  potentialLeaks: string[];
  recommendation: string;
  platform: string;
  nodeVersion: string;
  othersideVersion: string;
  warnings: string[];
}

function countInternal(method: string): number {
  const fn = (process as unknown as Record<string, () => unknown[]>)[method];
  return typeof fn === "function" ? fn.call(process).length : 0;
}

interface BunHeapStats {
  objectTypeCounts?: Record<string, number>;
  protectedObjectTypeCounts?: Record<string, number>;
  mimalloc?: unknown;
}

export function captureHeapDiagnostics(trigger: HeapDumpTrigger): HeapDiagnostics {
  const mem = process.memoryUsage();
  const uptimeSeconds = process.uptime();

  let heap: ReturnType<typeof v8.getHeapStatistics> | undefined;
  try {
    heap = v8.getHeapStatistics();
  } catch {}

  let heapSpaces: HeapDiagnostics["heapSpaces"];
  try {
    heapSpaces = v8.getHeapSpaceStatistics().map((space) => ({
      name: space.space_name,
      size: space.space_size,
      used: space.space_used_size,
      available: space.space_available_size,
    }));
  } catch {}

  let resourceUsage: HeapDiagnostics["resourceUsage"];
  try {
    const usage = process.resourceUsage();
    resourceUsage = {
      maxRSS: usage.maxRSS * (process.platform === "darwin" ? 1 : 1024),
      userCPUTime: usage.userCPUTime,
      systemCPUTime: usage.systemCPUTime,
    };
  } catch {}

  let smapsRollup: string | undefined;
  try {
    smapsRollup = readFileSync("/proc/self/smaps_rollup", "utf8");
  } catch {}

  let objectTypeCounts: Record<string, number> | undefined;
  let protectedObjectTypeCounts: Record<string, number> | undefined;
  let mimalloc: unknown;
  try {
    const { heapStats } = createRequire(import.meta.url)("bun:jsc") as {
      heapStats: (includeProtectedObjects: boolean) => BunHeapStats;
    };
    const stats = heapStats(true);
    objectTypeCounts = stats.objectTypeCounts;
    protectedObjectTypeCounts = stats.protectedObjectTypeCounts;
    mimalloc = stats.mimalloc;
  } catch {}

  const activeHandles = countInternal("_getActiveHandles");
  const activeRequests = countInternal("_getActiveRequests");
  let openFileDescriptors: number | undefined;
  try {
    openFileDescriptors = readdirSync("/proc/self/fd").length;
  } catch {}

  const nativeBytes = mem.rss - mem.heapUsed;
  const bytesPerSecond = uptimeSeconds > 0 ? mem.rss / uptimeSeconds : 0;
  const approxMbPerHour = (bytesPerSecond * 3600) / BYTES_PER_MB;

  const warnings: string[] = [];
  if (heap?.number_of_detached_contexts !== undefined && heap.number_of_detached_contexts > 0) {
    warnings.push(`${heap.number_of_detached_contexts} detached context(s)`);
  }
  if (activeHandles > HIGH_ACTIVE_HANDLES) {
    warnings.push(`${activeHandles} active handles (timer/socket retention?)`);
  }
  if (nativeBytes > mem.heapUsed) {
    warnings.push("native bytes exceed JS heap (native/allocator retention?)");
  }
  if (approxMbPerHour > HIGH_GROWTH_MB_PER_HOUR) {
    warnings.push(`avg growth ${approxMbPerHour.toFixed(1)} MB/hour`);
  }
  if (openFileDescriptors !== undefined && openFileDescriptors > HIGH_OPEN_FDS) {
    warnings.push(`${openFileDescriptors} open file descriptors`);
  }

  const potentialLeaks = [...warnings];

  return {
    timestamp: new Date().toISOString(),
    trigger,
    uptimeSeconds: Math.round(uptimeSeconds),
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    nativeBytes,
    heapSizeLimit: heap?.heap_size_limit,
    mallocedMemory: heap?.malloced_memory,
    peakMallocedMemory: heap?.peak_malloced_memory,
    detachedContexts: heap?.number_of_detached_contexts,
    nativeContexts: heap?.number_of_native_contexts,
    activeHandles,
    activeRequests,
    openFileDescriptors,
    bytesPerSecond,
    approxMbPerHour: Math.round(approxMbPerHour * 10) / 10,
    heapSpaces,
    resourceUsage,
    smapsRollup,
    objectTypeCounts,
    protectedObjectTypeCounts,
    mimalloc,
    potentialLeaks,
    recommendation:
      potentialLeaks.length > 0
        ? `WARNING: ${potentialLeaks.length} potential leak indicator(s) found. See potentialLeaks array.`
        : "No obvious leak indicators. Check heap snapshot for retained objects.",
    platform: process.platform,
    nodeVersion: process.version,
    othersideVersion: OTHERSIDE_VERSION,
    warnings,
  };
}

function bunRuntime():
  | {
      generateHeapSnapshot?: (a: string, b: string) => ArrayBuffer;
      gc?: (sync: boolean) => void;
    }
  | undefined {
  return (globalThis as { Bun?: ReturnType<typeof bunRuntime> }).Bun;
}

export async function writeHeapDump(
  trigger: HeapDumpTrigger,
): Promise<HeapDiagnostics | undefined> {
  try {
    const dir = heapDumpDir();
    mkdirSync(dir, { recursive: true });
    const diagnostics = captureHeapDiagnostics(trigger);
    const stamp = diagnostics.timestamp.replace(/[:.]/g, "-");
    writeFileSync(
      join(dir, `heap-${stamp}.diagnostics.json`),
      JSON.stringify(diagnostics, null, 2),
      {
        mode: 0o600,
      },
    );
    const bun = bunRuntime();
    const snapshot = bun?.generateHeapSnapshot?.("v8", "arraybuffer");
    if (snapshot !== undefined) {
      writeFileSync(join(dir, `heap-${stamp}.heapsnapshot`), new Uint8Array(snapshot), {
        mode: 0o600,
      });
      // Release the snapshot allocator's temporary buffers.
      bun?.gc?.(true);
    }
    return diagnostics;
  } catch {
    return undefined;
  }
}

function appendRssSample(): void {
  try {
    const dir = heapDumpDir();
    mkdirSync(dir, { recursive: true });
    const mem = process.memoryUsage();
    const mb = (bytes: number) => Math.round((bytes / BYTES_PER_MB) * 10) / 10;
    // native_mb (rss - heapUsed) is the bmalloc/native resident — the monotonic
    // accumulator the leak hunt tracks while the V8 heap stays flat.
    const line = {
      t: new Date().toISOString(),
      rss_mb: mb(mem.rss),
      heap_used_mb: mb(mem.heapUsed),
      heap_total_mb: mb(mem.heapTotal),
      external_mb: mb(mem.external),
      native_mb: mb(mem.rss - mem.heapUsed),
    };
    appendFileSync(join(dir, "heap-rss.jsonl"), `${JSON.stringify(line)}\n`, {
      mode: 0o600,
    });
  } catch {}
}

interface InspectorSession {
  connect(): void;
  disconnect(): void;
  post(method: string, callback?: (err: Error | null, result?: unknown) => void): void;
  post(
    method: string,
    params: unknown,
    callback?: (err: Error | null, result?: unknown) => void,
  ): void;
}

function inspectorPost(
  session: InspectorSession,
  method: string,
  params?: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, result?: unknown) => (err ? reject(err) : resolve(result));
    if (params === undefined) session.post(method, done);
    else session.post(method, params, done);
  });
}

let cpuSession: InspectorSession | undefined;
let cpuActive = false;

async function startCpuProfile(): Promise<void> {
  if (cpuActive) return;
  try {
    const inspector = await import("node:inspector");
    cpuSession = new inspector.Session() as unknown as InspectorSession;
    cpuSession.connect();
    const intervalUs = devtoolNumber("cpuProfileIntervalUs")!;
    await inspectorPost(cpuSession, "Profiler.enable");
    await inspectorPost(cpuSession, "Profiler.setSamplingInterval", {
      interval: intervalUs,
    });
    await inspectorPost(cpuSession, "Profiler.start");
    cpuActive = true;
  } catch {
    cpuSession = undefined;
  }
}

async function stopCpuProfileAndWrite(): Promise<void> {
  if (!cpuActive || cpuSession === undefined) return;
  const session = cpuSession;
  try {
    const result = (await inspectorPost(session, "Profiler.stop")) as {
      profile?: unknown;
    };
    if (result?.profile !== undefined) {
      const dir = heapDumpDir();
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      writeFileSync(join(dir, `cpu-${stamp}.cpuprofile`), JSON.stringify(result.profile), {
        mode: 0o600,
      });
    }
  } catch {
  } finally {
    try {
      session.disconnect();
    } catch {}
    cpuSession = undefined;
    cpuActive = false;
  }
}

function toggleCpuProfile(): Promise<void> {
  return cpuActive ? stopCpuProfileAndWrite() : startCpuProfile();
}

let installed = false;

export function installHeapDumpTrigger(): void {
  if (installed || !devtoolBoolean("heapDumpEnabled")) return;
  installed = true;

  process.on("SIGUSR2", () => {
    void writeHeapDump("signal");
  });

  process.on("SIGUSR1", () => {
    void toggleCpuProfile();
  });

  const cpuChunkSec = devtoolNumber("cpuProfileSeconds");
  if (cpuChunkSec !== undefined) {
    const profileChunk = () => {
      void startCpuProfile();
      const stop = setTimeout(
        () => void stopCpuProfileAndWrite().then(profileChunk),
        cpuChunkSec * 1000,
      );
      stop.unref?.();
    };
    profileChunk();
  }

  const thresholdMb = devtoolNumber("heapDumpAutoMb");
  const sampleMs = devtoolNumber("heapDumpSampleMs")!;
  let dumpedAtThreshold = false;
  const timer = setInterval(() => {
    appendRssSample();
    if (thresholdMb !== undefined && !dumpedAtThreshold) {
      if (process.memoryUsage().rss / BYTES_PER_MB >= thresholdMb) {
        dumpedAtThreshold = true;
        void writeHeapDump("threshold");
      }
    }
  }, sampleMs);
  timer.unref?.();
}
