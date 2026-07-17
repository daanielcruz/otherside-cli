import { readFileSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { findModel } from "@/engine/model/catalog.ts";
import type { PermissionMode } from "@/kernel/std/types/request.ts";

export type CliMode =
  | {
      kind: "interactive";
      yolo: boolean;
      permissionMode: PermissionMode | null;
      resumeSessionId: string | null;
      resumeLatest: boolean;
      model: string | null;
      provider: string | null;
      /** `--worktree [name]`: enter a session worktree at launch (null name = auto). */
      worktree: { name: string | null } | null;
      /** `--tmux`: with `--worktree`, also create a companion tmux session in it. */
      tmux: boolean;
    }
  | {
      kind: "print";
      prompt: string;
      yolo: boolean;
      permissionMode: PermissionMode | null;
      outputFormat: "text" | "json" | "stream-json";
      verbose: boolean;
      model: string | null;
      effort: string | null;
      provider: string | null;
      resumeSessionId: string | null;
      resumeLatest: boolean;
      sessionId?: string | null;
      forkSession?: boolean;
      addDirs?: string[];
      maxTurns: number | null;
      maxBudgetUsd?: number | null;
      fallbackModel?: string | null;
      systemPrompt?: string | null;
      appendSystemPrompt?: string | null;
      includePartialMessages?: boolean;
      mcpConfigs?: string[];
      agentsJson?: string | null;
      jsonSchema?: Record<string, unknown> | null;
      /** `--worktree [name]`: enter a session worktree at launch (null name = auto). */
      worktree: { name: string | null } | null;
      /** `--tmux`: with `--worktree`, also create a companion tmux session in it. */
      tmux: boolean;
    }
  | { kind: "logout"; provider: string | null }
  | { kind: "statusline" }
  | { kind: "piped" }
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "error"; message: string; code: number };

const PERMISSION_MODE_ALIASES: Record<string, PermissionMode> = {
  default: "default",
  "accept-edits": "accept-edits",
  acceptedits: "accept-edits",
  acceptEdits: "accept-edits",
  plan: "plan",
  yolo: "yolo",
  bypass: "yolo",
  bypassPermissions: "yolo",
};

function parsePermissionMode(raw: string | null): PermissionMode | null {
  if (raw === null) return null;
  return PERMISSION_MODE_ALIASES[raw] ?? null;
}

// Internal permission mode → the wire value emitted on the headless surface.
// A full-set Record keeps this exhaustive: a new PermissionMode breaks tsc here.
const PERMISSION_MODE_WIRE: Record<PermissionMode, string> = {
  default: "default",
  "accept-edits": "acceptEdits",
  plan: "plan",
  yolo: "bypassPermissions",
};

export function permissionModeToWire(mode: PermissionMode): string {
  return PERMISSION_MODE_WIRE[mode];
}

// Flags that consume the following argv token as their value. The print-mode
// positional collector must skip both the flag and its value, otherwise a
// flag value (e.g. `--output-format json`) is mistaken for the prompt.
const PRINT_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--output-format",
  "--model",
  "--provider",
  "--effort",
  "--permission-mode",
  "--settings",
  "--resume",
  "--session-id",
  "--add-dir",
  "--max-turns",
  "--max-budget-usd",
  "--fallback-model",
  "--system-prompt",
  "--append-system-prompt",
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--disallowed-tools",
  "--plugin-dir",
  "--mcp-config",
  "--agents",
  "--json-schema",
]);

function parseOutputFormat(raw: string | null): "text" | "json" | "stream-json" {
  if (raw === "stream-json") return "stream-json";
  if (raw === "json") return "json";
  return "text";
}

function parsePositiveInt(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseNonNegativeUsd(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateInlineMcpConfig(rawConfigs: string[]): string | null {
  for (const raw of rawConfigs) {
    const trimmed = raw.trimStart();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return `otherside: invalid --mcp-config JSON (${error instanceof Error ? error.message : String(error)})`;
    }
    if (!isObjectRecord(parsed) || !isObjectRecord(parsed.mcpServers)) {
      return "otherside: invalid --mcp-config (expected JSON object with mcpServers object)";
    }
  }
  return null;
}

function validateAgentsJson(raw: string | null): string | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return `otherside: invalid --agents JSON (${error instanceof Error ? error.message : String(error)})`;
  }
  if (!isObjectRecord(parsed)) return "otherside: invalid --agents (expected JSON object)";
  for (const [name, def] of Object.entries(parsed)) {
    if (!isObjectRecord(def))
      return `otherside: invalid --agents entry "${name}" (expected object)`;
    if (typeof def.description !== "string" || def.description.trim().length === 0) {
      return `otherside: invalid --agents entry "${name}" (missing description)`;
    }
    if (typeof def.prompt !== "string" || def.prompt.trim().length === 0) {
      return `otherside: invalid --agents entry "${name}" (missing prompt)`;
    }
    if (
      def.tools !== undefined &&
      (!Array.isArray(def.tools) || !def.tools.every((tool) => typeof tool === "string"))
    ) {
      return `otherside: invalid --agents entry "${name}" (tools must be strings)`;
    }
    if (def.model !== undefined && typeof def.model !== "string") {
      return `otherside: invalid --agents entry "${name}" (model must be a string)`;
    }
  }
  return null;
}

type JsonSchemaParseResult =
  | { schema: Record<string, unknown> | null; error: null }
  | { schema: null; error: string };

function parseJsonSchemaOption(raw: string | null): JsonSchemaParseResult {
  if (raw === null) return { schema: null, error: null };
  let text: string;
  try {
    text = raw.trimStart().startsWith("{") ? raw : readFileSync(resolve(raw), "utf8");
  } catch (error) {
    return {
      schema: null,
      error: `otherside: invalid --json-schema (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      schema: null,
      error: `otherside: invalid --json-schema JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (!isObjectRecord(parsed)) {
    return { schema: null, error: "otherside: invalid --json-schema (expected JSON object)" };
  }
  return { schema: parsed, error: null };
}

/**
 * `-w, --worktree [name]` — the value is optional: a following token is the
 * name only when it is not another flag; `--worktree=name` binds explicitly.
 */
function worktreeOption(argv: string[]): { name: string | null } | null {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--worktree" || arg === "-w") {
      const next = argv[i + 1];
      return { name: next && !next.startsWith("-") ? next : null };
    }
    if (arg.startsWith("--worktree=")) {
      const value = arg.slice("--worktree=".length);
      return { name: value.length > 0 ? value : null };
    }
  }
  return null;
}

/** `--tmux` (and its `--tmux=classic` spelling) — only meaningful with `--worktree`. */
function tmuxOption(argv: string[]): boolean {
  return argv.includes("--tmux") || argv.includes("--tmux=classic");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(raw: string): boolean {
  return UUID_RE.test(raw);
}

export function parseArgs(argv: string[]): CliMode {
  if (argv.includes("--version") || argv.includes("-v")) return { kind: "version" };
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  if (argv.includes("--statusline")) return { kind: "statusline" };
  if (argv[2] === "logout") {
    return {
      kind: "logout",
      provider: optionValue(argv, "--provider") ?? positionalAfter(argv, "logout"),
    };
  }
  applyCliFlagsToEnv(argv);
  const permissionModeRaw = optionValue(argv, "--permission-mode");
  const permissionMode = parsePermissionMode(permissionModeRaw);
  // An explicitly-passed but unrecognized --permission-mode is a hard CLI error,
  // never a silent fallback to config default.
  if (permissionModeRaw !== null && permissionMode === null) {
    return {
      kind: "error",
      message: `otherside: invalid --permission-mode "${permissionModeRaw}" (expected: default, acceptEdits, plan, bypassPermissions)`,
      code: 1,
    };
  }
  const yolo =
    argv.includes("--yolo") ||
    argv.includes("--dangerously-skip-permissions") ||
    permissionMode === "yolo";
  const printIdx = printFlagIndex(argv);
  if (printIdx >= 0) {
    const prompt = consumePrintPrompt(argv, printIdx);
    const outputFormat = parseOutputFormat(optionValue(argv, "--output-format"));
    const sessionId = optionValue(argv, "--session-id");
    if (sessionId !== null && !isUuid(sessionId)) {
      return {
        kind: "error",
        message: `otherside: invalid --session-id "${sessionId}" (expected UUID)`,
        code: 1,
      };
    }
    const budgetRaw = optionValue(argv, "--max-budget-usd");
    const maxBudgetUsd = parseNonNegativeUsd(budgetRaw);
    if (budgetRaw !== null && maxBudgetUsd === null) {
      return {
        kind: "error",
        message: `otherside: invalid --max-budget-usd "${budgetRaw}" (expected non-negative number)`,
        code: 1,
      };
    }
    const fallbackModel = optionValue(argv, "--fallback-model");
    if (fallbackModel !== null && !findModel(fallbackModel)) {
      return {
        kind: "error",
        message: `otherside: invalid --fallback-model "${fallbackModel}" (model not found)`,
        code: 1,
      };
    }
    const resumeSessionId = optionValue(argv, "--resume");
    const resumeLatest = argv.includes("-c") || argv.includes("--continue");
    const addDirs = optionValues(argv, "--add-dir");
    const mcpConfigs = mcpConfigValues(argv);
    const mcpConfigError = validateInlineMcpConfig(mcpConfigs);
    if (mcpConfigError !== null) return { kind: "error", message: mcpConfigError, code: 1 };
    const agentsJson = optionValue(argv, "--agents");
    const agentsError = validateAgentsJson(agentsJson);
    if (agentsError !== null) return { kind: "error", message: agentsError, code: 1 };
    const jsonSchemaResult = parseJsonSchemaOption(optionValue(argv, "--json-schema"));
    if (jsonSchemaResult.error !== null) {
      delete process.env.OTHERSIDE_CLI_JSON_SCHEMA;
      return { kind: "error", message: jsonSchemaResult.error, code: 1 };
    }
    if (jsonSchemaResult.schema !== null) {
      process.env.OTHERSIDE_CLI_JSON_SCHEMA = JSON.stringify(jsonSchemaResult.schema);
    } else {
      delete process.env.OTHERSIDE_CLI_JSON_SCHEMA;
    }
    return {
      kind: "print",
      prompt,
      yolo,
      permissionMode,
      outputFormat,
      verbose: argv.includes("--verbose"),
      model: optionValue(argv, "--model"),
      effort: optionValue(argv, "--effort"),
      provider: optionValue(argv, "--provider"),
      resumeSessionId,
      resumeLatest,
      sessionId,
      forkSession: argv.includes("--fork-session"),
      addDirs,
      maxTurns: parsePositiveInt(optionValue(argv, "--max-turns")),
      maxBudgetUsd,
      fallbackModel,
      systemPrompt: optionValue(argv, "--system-prompt"),
      appendSystemPrompt: optionValue(argv, "--append-system-prompt"),
      includePartialMessages: argv.includes("--include-partial-messages"),
      mcpConfigs,
      agentsJson,
      jsonSchema: jsonSchemaResult.schema,
      worktree: worktreeOption(argv),
      tmux: tmuxOption(argv),
    };
  }
  const resumeSessionId = optionValue(argv, "--resume");
  const resumeLatest = argv.includes("-c") || argv.includes("--continue");
  if (!process.stdin.isTTY && resumeSessionId === null && !resumeLatest) return { kind: "piped" };
  return {
    kind: "interactive",
    yolo,
    permissionMode,
    resumeSessionId,
    resumeLatest,
    model: optionValue(argv, "--model"),
    provider: optionValue(argv, "--provider"),
    worktree: worktreeOption(argv),
    tmux: tmuxOption(argv),
  };
}

function printFlagIndex(argv: string[]): number {
  const long = argv.indexOf("--print");
  if (long >= 0) return long;
  return argv.indexOf("-p");
}

function consumePrintPrompt(argv: string[], printIdx: number): string {
  const sepIdx = argv.indexOf("--", printIdx + 1);
  if (sepIdx >= 0) {
    return argv.slice(sepIdx + 1).join(" ");
  }
  // The prompt is every positional token — everything that is neither a flag
  // nor a value consumed by a value-flag (nor the print flag itself). Multiple
  // positionals are joined to match the prompt-join behavior.
  const printFlag = argv[printIdx];
  const positionals: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || arg === printFlag) continue;
    if (arg.startsWith("-")) {
      if (arg === "--mcp-config") {
        while (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) i += 1;
      } else if (arg === "--worktree" || arg === "-w") {
        // Optional value: only a following non-flag token belongs to the flag.
        if (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) i += 1;
      } else if (!arg.includes("=") && PRINT_VALUE_FLAGS.has(arg)) i += 1;
      continue;
    }
    positionals.push(arg);
  }
  return positionals.join(" ");
}

function optionValue(argv: string[], flag: string): string | null {
  const eq = argv.find((arg) => arg.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const idx = argv.indexOf(flag);
  if (idx < 0) return null;
  const value = argv[idx + 1];
  return value && !value.startsWith("-") ? value : null;
}

// Every occurrence of a repeatable flag (e.g. `--plugin-dir a --plugin-dir b`).
function optionValues(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith(`${flag}=`)) {
      const v = arg.slice(flag.length + 1);
      if (v) out.push(v);
    } else if (arg === flag) {
      const v = argv[i + 1];
      if (v && !v.startsWith("-")) out.push(v);
    }
  }
  return out;
}

function mcpConfigValues(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--mcp-config=")) {
      const value = arg.slice("--mcp-config=".length);
      if (value) out.push(value);
    } else if (arg === "--mcp-config") {
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) {
        const value = argv[++i];
        if (value) out.push(value);
      }
    }
  }
  return out;
}

function positionalAfter(argv: string[], command: string): string | null {
  const idx = argv.indexOf(command);
  if (idx < 0) return null;
  const value = argv[idx + 1];
  return value && !value.startsWith("-") ? value : null;
}

function applyCliFlagsToEnv(argv: string[]): void {
  // Mirror the launch-time safe-mode flag so dispatched sub-sessions (which
  // inherit env, not argv) stay restricted, and so env-only setups can opt in.
  if (argv.includes("--safe-mode")) process.env.OTHERSIDE_SAFE_MODE = "1";
  const settings = optionValue(argv, "--settings");
  if (settings) process.env.OTHERSIDE_FLAG_SETTINGS = settings;
  const allow = optionValue(argv, "--allowedTools") ?? optionValue(argv, "--allowed-tools");
  if (allow) process.env.OTHERSIDE_CLI_ALLOWED_TOOLS = allow;
  const deny = optionValue(argv, "--disallowedTools") ?? optionValue(argv, "--disallowed-tools");
  if (deny) process.env.OTHERSIDE_CLI_DISALLOWED_TOOLS = deny;
  // Session-only extra plugin dirs (repeatable). Read by engine/corpus.ts.
  const pluginDirs = optionValues(argv, "--plugin-dir");
  if (pluginDirs.length > 0) process.env.OTHERSIDE_FLAG_PLUGIN_DIRS = pluginDirs.join(delimiter);
  const sessionId = optionValue(argv, "--session-id");
  if (sessionId) process.env.OTHERSIDE_CLI_SESSION_ID = sessionId;
  if (argv.includes("--fork-session")) process.env.OTHERSIDE_CLI_FORK_SESSION = "1";
  if (argv.includes("--include-partial-messages")) {
    process.env.OTHERSIDE_CLI_INCLUDE_PARTIAL_MESSAGES = "1";
  }
  const systemPrompt = optionValue(argv, "--system-prompt");
  if (systemPrompt !== null) process.env.OTHERSIDE_CLI_SYSTEM_PROMPT = systemPrompt;
  const appendSystemPrompt = optionValue(argv, "--append-system-prompt");
  if (appendSystemPrompt !== null) {
    process.env.OTHERSIDE_CLI_APPEND_SYSTEM_PROMPT = appendSystemPrompt;
  }
  const budget = optionValue(argv, "--max-budget-usd");
  if (budget !== null) process.env.OTHERSIDE_CLI_MAX_BUDGET_USD = budget;
  const fallbackModel = optionValue(argv, "--fallback-model");
  if (fallbackModel !== null) process.env.OTHERSIDE_CLI_FALLBACK_MODEL = fallbackModel;
  if (optionValue(argv, "--resume") || argv.includes("-c") || argv.includes("--continue")) {
    process.env.OTHERSIDE_CLI_RESUME_ACTIVE = "1";
  }
  const addDirs = optionValues(argv, "--add-dir");
  if (addDirs.length > 0) process.env.OTHERSIDE_CLI_ADD_DIRS = JSON.stringify(addDirs);
  const mcpConfigs = mcpConfigValues(argv);
  if (mcpConfigs.length > 0) process.env.OTHERSIDE_CLI_MCP_CONFIGS = JSON.stringify(mcpConfigs);
  const agentsJson = optionValue(argv, "--agents");
  if (agentsJson !== null) process.env.OTHERSIDE_CLI_AGENTS_JSON = agentsJson;
}
