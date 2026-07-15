const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

export const DEVTOOL_SETTINGS = {
  allocLever: { env: "OTHERSIDE_ALLOC_LEVER", kind: "boolean", default: false },
  allocLeverDisabled: {
    env: "OTHERSIDE_NO_ALLOC_LEVER",
    kind: "boolean",
    default: false,
  },
  codexRawStreamCapture: {
    env: "OTHERSIDE_CODEX_RAW_STREAM_CAPTURE",
    kind: "path",
    default: undefined,
  },
  codexRawStreamReplay: {
    env: "OTHERSIDE_CODEX_RAW_STREAM_REPLAY",
    kind: "path",
    default: undefined,
  },
  codexRawStreamReplayNoopTools: {
    env: "OTHERSIDE_CODEX_RAW_STREAM_REPLAY_NOOP_TOOLS",
    kind: "boolean",
    default: false,
  },
  codexRawStreamReplayDiagnostics: {
    env: "OTHERSIDE_CODEX_RAW_STREAM_REPLAY_DIAG",
    kind: "path",
    default: undefined,
  },
  commitLog: { env: "OTHERSIDE_COMMIT_LOG", kind: "path", default: undefined },
  cpuProfileIntervalUs: {
    env: "OTHERSIDE_CPUPROFILE_INTERVAL_US",
    kind: "number",
    default: 500,
  },
  cpuProfileSeconds: {
    env: "OTHERSIDE_CPUPROFILE_SEC",
    kind: "number",
    default: undefined,
  },
  debugLogDir: {
    env: "OTHERSIDE_DEBUG_LOG_DIR",
    kind: "path",
    default: undefined,
  },
  gcCadence: { env: "OTHERSIDE_GC_CADENCE", kind: "boolean", default: false },
  gcDecommit: { env: "OTHERSIDE_GC_DECOMMIT", kind: "boolean", default: false },
  gcDiagnostics: { env: "OTHERSIDE_GC_DIAG", kind: "path", default: undefined },
  heapDumpAutoMb: {
    env: "OTHERSIDE_HEAPDUMP_AUTO_MB",
    kind: "number",
    default: undefined,
  },
  heapDumpEnabled: {
    env: "OTHERSIDE_DEBUG_HEAPDUMP",
    kind: "boolean",
    default: false,
  },
  heapDumpSampleMs: {
    env: "OTHERSIDE_HEAPDUMP_SAMPLE_MS",
    kind: "number",
    default: 10_000,
  },
  frameTiming: {
    env: "OTHERSIDE_FRAME_TIMING_LOG",
    kind: "boolean",
    default: false,
  },
  inkDevtools: {
    env: "OTHERSIDE_INK_DEVTOOLS",
    kind: "boolean",
    default: false,
  },
  payloadDiagnostics: {
    env: "OTHERSIDE_PAYLOAD_DIAG",
    kind: "path",
    default: undefined,
  },
  mcpPayloadDiagnostics: {
    env: "OTHERSIDE_MCP_PAYLOAD_DIAG",
    kind: "path",
    default: undefined,
  },
  renderCounters: {
    env: "OTHERSIDE_RENDER_DIAG",
    kind: "boolean",
    default: false,
  },
  diagnosticOutput: {
    env: "OTHERSIDE_RENDER_DIAGNOSTICS",
    kind: "boolean",
    default: false,
  },
  repaintDiagnostics: {
    env: "OTHERSIDE_DEBUG_REPAINTS",
    kind: "boolean",
    default: false,
  },
  resumeModel: {
    env: "OTHERSIDE_DEVTOOLS_RESUME_MODEL",
    kind: "string",
    default: undefined,
  },
  resumeProvider: {
    env: "OTHERSIDE_DEVTOOLS_RESUME_PROVIDER",
    kind: "string",
    default: undefined,
  },
  shellDiagnostics: {
    env: "OTHERSIDE_DEBUG_SHELL",
    kind: "boolean",
    default: false,
  },
  stallDiagnostics: {
    env: "OTHERSIDE_DEBUG_STALL",
    kind: "boolean",
    default: false,
  },
  streamCloseDiagnostics: {
    env: "OTHERSIDE_DEBUG_STREAM_CLOSE",
    kind: "boolean",
    default: false,
  },
  streamDebug: {
    env: "OTHERSIDE_DEBUG_STREAM",
    kind: "boolean",
    default: false,
  },
  trace: { env: "OTHERSIDE_TRACE", kind: "boolean", default: false },
  wireDiagnostics: {
    env: "OTHERSIDE_DEBUG_WIRE",
    kind: "boolean",
    default: false,
  },
} as const;

export type DevtoolSettingName = keyof typeof DEVTOOL_SETTINGS;

export function devtoolBoolean(name: DevtoolSettingName): boolean {
  const setting = DEVTOOL_SETTINGS[name];
  if (setting.kind !== "boolean") throw new Error(`devtool setting is not boolean: ${name}`);
  const value = process.env[setting.env];
  if (value === undefined) return setting.default;
  const normalized = value.trim().toLowerCase();
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  return setting.default;
}

export function devtoolNumber(name: DevtoolSettingName): number | undefined {
  const setting = DEVTOOL_SETTINGS[name];
  if (setting.kind !== "number") throw new Error(`devtool setting is not numeric: ${name}`);
  const value = process.env[setting.env];
  if (value === undefined || value.trim() === "") return setting.default;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : setting.default;
}

export function devtoolPath(name: DevtoolSettingName): string | undefined {
  const setting = DEVTOOL_SETTINGS[name];
  if (setting.kind !== "path") throw new Error(`devtool setting is not a path: ${name}`);
  return process.env[setting.env]?.trim() || setting.default;
}

export function devtoolString(name: DevtoolSettingName): string | undefined {
  const setting = DEVTOOL_SETTINGS[name];
  if (setting.kind !== "string") throw new Error(`devtool setting is not a string: ${name}`);
  return process.env[setting.env]?.trim() || setting.default;
}
