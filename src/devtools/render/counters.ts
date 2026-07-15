import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { heapDumpDir } from "@/devtools/memory/heap-dump.ts";
import { devtoolBoolean } from "@/devtools/settings.ts";

const ENABLED = devtoolBoolean("renderCounters");
const SAMPLE_INTERVAL_MS = 1000;
const BYTES_PER_MB = 1024 * 1024;

let renders = 0;
let drains = 0;
let transcriptRenders = 0;
let rendererMsSum = 0;
let rendererMsMax = 0;
let rendererMsCount = 0;
let memoBreaks: Record<string, number> = {};
let installed = false;

function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  const dir = heapDumpDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
  const mb = (bytes: number): number => Math.round((bytes / BYTES_PER_MB) * 10) / 10;
  const timer = setInterval(() => {
    const mem = process.memoryUsage();
    const line = {
      t: new Date().toISOString(),
      renders_per_s: renders,
      drains_per_s: drains,
      transcript_renders_per_s: transcriptRenders,
      memo_breaks: memoBreaks,
      renderer_ms_max: Math.round(rendererMsMax * 100) / 100,
      renderer_ms_avg:
        rendererMsCount > 0 ? Math.round((rendererMsSum / rendererMsCount) * 100) / 100 : 0,
      rss_mb: mb(mem.rss),
      external_mb: mb(mem.external),
      heap_used_mb: mb(mem.heapUsed),
      array_buffers_mb: mb(mem.arrayBuffers),
    };
    renders = 0;
    drains = 0;
    transcriptRenders = 0;
    rendererMsSum = 0;
    rendererMsMax = 0;
    rendererMsCount = 0;
    memoBreaks = {};
    try {
      appendFileSync(join(dir, "render-diag.jsonl"), `${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch {}
  }, SAMPLE_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
}

export function bumpRender(): void {
  if (!ENABLED) return;
  renders += 1;
  ensureInstalled();
}

export function bumpDrain(): void {
  if (!ENABLED) return;
  drains += 1;
}

export function bumpRendererMs(ms: number): void {
  if (!ENABLED) return;
  rendererMsSum += ms;
  rendererMsCount += 1;
  if (ms > rendererMsMax) rendererMsMax = ms;
}

export function bumpTranscriptRender(): void {
  if (!ENABLED) return;
  transcriptRenders += 1;
  ensureInstalled();
}

export function bumpTranscriptMemoBreak(reason: string): void {
  if (!ENABLED) return;
  memoBreaks[reason] = (memoBreaks[reason] ?? 0) + 1;
}
