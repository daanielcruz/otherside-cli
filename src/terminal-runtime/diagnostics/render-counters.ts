import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { heapDumpDir } from "@/devtools/memory/heap-dump.ts";
import { devtoolBoolean } from "@/devtools/settings.ts";

const ENABLED = devtoolBoolean("renderCounters");
const SAMPLE_INTERVAL_MS = 1000;
const EVENT_LOOP_SAMPLE_INTERVAL_MS = 20;
const BYTES_PER_MB = 1024 * 1024;

interface MetricAccumulator {
  count: number;
  max: number;
  sum: number;
}

/** Inlined from the deleted cell-grid paint pipeline; diagnostics only. */
type FrameMetrics = {
  durationMs: number;
  phases?: {
    renderer: number;
    diff: number;
    optimize: number;
    write: number;
    patches: number;
    yoga: number;
    commit: number;
    yogaVisited?: number;
    yogaMeasured?: number;
    yogaCacheHits?: number;
    yogaLive?: number;
    domLive?: number;
    fiberLive?: number;
  };
};

type LineWriterMode = "noop" | "full-redraw" | "append" | "rewrite";

export interface PaintFrameDiagnostic {
  metrics: FrameMetrics;
  screenRows: number;
  viewportRows: number;
  viewportTop: number;
  cursorDocumentRow: number;
  cursorScreenRow: number;
  damageRows: number;
  outputBytes: number;
  lineWriterMode: LineWriterMode;
  destructiveReset: boolean;
  firstChangedRow: number | null;
  lastChangedRow: number | null;
  inputToPaintMs?: number;
}

interface PaintFrameSample {
  at_ms: number;
  frame_ms: number;
  renderer_ms: number;
  yoga_ms: number;
  commit_ms: number;
  diff_ms: number;
  optimize_ms: number;
  write_ms: number;
  patches: number;
  screen_rows: number;
  viewport_rows: number;
  viewport_top: number;
  cursor_document_row: number;
  cursor_screen_row: number;
  damage_rows: number;
  output_bytes: number;
  writer_mode: LineWriterMode;
  destructive_reset: boolean;
  first_changed_row: number | null;
  last_changed_row: number | null;
  input_to_paint_ms?: number;
  components: Record<string, number>;
  memo_breaks: Record<string, number>;
}

const metric = (): MetricAccumulator => ({ count: 0, max: 0, sum: 0 });

let renders = 0;
let transcriptRenders = 0;
let outputFrames = 0;
let outputBytes = 0;
let destructiveResets = 0;
let screenRowsMax = 0;
let writerModes: Partial<Record<LineWriterMode, number>> = {};
let componentRenders: Record<string, number> = {};
let memoBreaks: Record<string, number> = {};
let pendingFrameComponents: Record<string, number> = {};
let pendingFrameMemoBreaks: Record<string, number> = {};
let frameSamples: PaintFrameSample[] = [];
let installed = false;

const frameMs = metric();
const rendererMs = metric();
const yogaMs = metric();
const commitMs = metric();
const diffMs = metric();
const optimizeMs = metric();
const writeMs = metric();
const patches = metric();
const damageRows = metric();
const inputToPaintMs = metric();
const eventLoopDelayMs = metric();

function addMetric(target: MetricAccumulator, value: number): void {
  target.sum += value;
  target.count += 1;
  if (value > target.max) target.max = value;
}

function resetMetric(target: MetricAccumulator): void {
  target.count = 0;
  target.max = 0;
  target.sum = 0;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function average(target: MetricAccumulator): number {
  return target.count > 0 ? rounded(target.sum / target.count) : 0;
}

function resetSample(): void {
  renders = 0;
  transcriptRenders = 0;
  outputFrames = 0;
  outputBytes = 0;
  destructiveResets = 0;
  screenRowsMax = 0;
  writerModes = {};
  componentRenders = {};
  memoBreaks = {};
  frameSamples = [];
  resetMetric(frameMs);
  resetMetric(rendererMs);
  resetMetric(yogaMs);
  resetMetric(commitMs);
  resetMetric(diffMs);
  resetMetric(optimizeMs);
  resetMetric(writeMs);
  resetMetric(patches);
  resetMetric(damageRows);
  resetMetric(inputToPaintMs);
  resetMetric(eventLoopDelayMs);
}

function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  const dir = heapDumpDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}

  let previousLoopSample = performance.now();
  const eventLoopTimer = setInterval(() => {
    const now = performance.now();
    addMetric(
      eventLoopDelayMs,
      Math.max(0, now - previousLoopSample - EVENT_LOOP_SAMPLE_INTERVAL_MS),
    );
    previousLoopSample = now;
  }, EVENT_LOOP_SAMPLE_INTERVAL_MS);
  (eventLoopTimer as { unref?: () => void }).unref?.();

  const mb = (bytes: number): number => Math.round((bytes / BYTES_PER_MB) * 10) / 10;
  const timer = setInterval(() => {
    const mem = process.memoryUsage();
    const line = {
      t: new Date().toISOString(),
      renders_per_s: renders,
      transcript_renders_per_s: transcriptRenders,
      component_renders: componentRenders,
      memo_breaks: memoBreaks,
      frames_per_s: frameMs.count,
      output_frames_per_s: outputFrames,
      writer_modes: writerModes,
      destructive_resets: destructiveResets,
      frame_ms_max: rounded(frameMs.max),
      frame_ms_avg: average(frameMs),
      renderer_ms_max: rounded(rendererMs.max),
      renderer_ms_avg: average(rendererMs),
      yoga_ms_max: rounded(yogaMs.max),
      yoga_ms_avg: average(yogaMs),
      commit_ms_max: rounded(commitMs.max),
      commit_ms_avg: average(commitMs),
      diff_ms_max: rounded(diffMs.max),
      diff_ms_avg: average(diffMs),
      optimize_ms_max: rounded(optimizeMs.max),
      optimize_ms_avg: average(optimizeMs),
      write_ms_max: rounded(writeMs.max),
      write_ms_avg: average(writeMs),
      patches_total: rounded(patches.sum),
      patches_max: rounded(patches.max),
      damage_rows_total: rounded(damageRows.sum),
      damage_rows_max: rounded(damageRows.max),
      screen_rows_max: screenRowsMax,
      output_bytes: outputBytes,
      input_to_paint_samples: inputToPaintMs.count,
      input_to_paint_ms_max: rounded(inputToPaintMs.max),
      input_to_paint_ms_avg: average(inputToPaintMs),
      frame_samples: frameSamples,
      event_loop_delay_ms_max: rounded(eventLoopDelayMs.max),
      event_loop_delay_ms_avg: average(eventLoopDelayMs),
      rss_mb: mb(mem.rss),
      external_mb: mb(mem.external),
      heap_used_mb: mb(mem.heapUsed),
      array_buffers_mb: mb(mem.arrayBuffers),
    };
    resetSample();
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

export function bumpRendererMs(ms: number): void {
  if (!ENABLED) return;
  addMetric(rendererMs, ms);
  ensureInstalled();
}

export function bumpComponentRender(component: string): void {
  if (!ENABLED) return;
  componentRenders[component] = (componentRenders[component] ?? 0) + 1;
  pendingFrameComponents[component] = (pendingFrameComponents[component] ?? 0) + 1;
  ensureInstalled();
}

export function recordPaintFrame(diagnostic: PaintFrameDiagnostic): void {
  if (!ENABLED) return;
  const phases = diagnostic.metrics.phases;
  addMetric(frameMs, diagnostic.metrics.durationMs);
  if (phases !== undefined) {
    addMetric(rendererMs, phases.renderer);
    addMetric(yogaMs, phases.yoga);
    addMetric(commitMs, phases.commit);
    addMetric(diffMs, phases.diff);
    addMetric(optimizeMs, phases.optimize);
    addMetric(writeMs, phases.write);
    addMetric(patches, phases.patches);
  }
  addMetric(damageRows, diagnostic.damageRows);
  if (diagnostic.outputBytes > 0) outputFrames += 1;
  outputBytes += diagnostic.outputBytes;
  writerModes[diagnostic.lineWriterMode] = (writerModes[diagnostic.lineWriterMode] ?? 0) + 1;
  if (diagnostic.destructiveReset) destructiveResets += 1;
  screenRowsMax = Math.max(screenRowsMax, diagnostic.screenRows);
  if (diagnostic.inputToPaintMs !== undefined) {
    addMetric(inputToPaintMs, diagnostic.inputToPaintMs);
  }
  frameSamples.push({
    at_ms: rounded(performance.now()),
    frame_ms: rounded(diagnostic.metrics.durationMs),
    renderer_ms: rounded(phases?.renderer ?? 0),
    yoga_ms: rounded(phases?.yoga ?? 0),
    commit_ms: rounded(phases?.commit ?? 0),
    diff_ms: rounded(phases?.diff ?? 0),
    optimize_ms: rounded(phases?.optimize ?? 0),
    write_ms: rounded(phases?.write ?? 0),
    patches: phases?.patches ?? 0,
    screen_rows: diagnostic.screenRows,
    viewport_rows: diagnostic.viewportRows,
    viewport_top: diagnostic.viewportTop,
    cursor_document_row: diagnostic.cursorDocumentRow,
    cursor_screen_row: diagnostic.cursorScreenRow,
    damage_rows: diagnostic.damageRows,
    output_bytes: diagnostic.outputBytes,
    writer_mode: diagnostic.lineWriterMode,
    destructive_reset: diagnostic.destructiveReset,
    first_changed_row: diagnostic.firstChangedRow,
    last_changed_row: diagnostic.lastChangedRow,
    ...(diagnostic.inputToPaintMs === undefined
      ? {}
      : { input_to_paint_ms: rounded(diagnostic.inputToPaintMs) }),
    components: pendingFrameComponents,
    memo_breaks: pendingFrameMemoBreaks,
  });
  pendingFrameComponents = {};
  pendingFrameMemoBreaks = {};
  ensureInstalled();
}

export function bumpTranscriptRender(): void {
  if (!ENABLED) return;
  transcriptRenders += 1;
  ensureInstalled();
}

export function bumpTranscriptMemoBreak(reason: string): void {
  if (!ENABLED) return;
  memoBreaks[reason] = (memoBreaks[reason] ?? 0) + 1;
  pendingFrameMemoBreaks[reason] = (pendingFrameMemoBreaks[reason] ?? 0) + 1;
  ensureInstalled();
}
