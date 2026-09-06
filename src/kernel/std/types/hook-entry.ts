export interface CommandHookEntry {
  type?: "command";
  matcher: string;
  command: string;
  /** Execution budget in SECONDS; absent falls back to the per-event default. */
  timeout?: number;
  // Set when the hook came from a plugin manifest: its install dir, used to
  // expand ${CLAUDE_PLUGIN_ROOT} in the command and inject CLAUDE_PLUGIN_ROOT
  // into the spawn env. Undefined for user/project hooks (no injection).
  pluginRoot?: string;
  // Async execution flags (Stop hooks): `async` backgrounds the hook
  // (fire-and-forget); `asyncRewake` backgrounds it AND, when it exits with
  // code 2 on an interactive session, enqueues a rewake task-notification
  // (`rewakeMessage` overrides the body prefix, `rewakeSummary` the summary).
  // Consumed by engine/queue/runtime/stop-hook-rewake.ts.
  async?: boolean;
  asyncRewake?: boolean;
  rewakeMessage?: string;
  rewakeSummary?: string;
}

export interface PromptHookEntry {
  type: "prompt";
  matcher: string;
  prompt: string;
  /** Execution budget in SECONDS; absent falls back to the per-event default. */
  timeout?: number;
}

export interface AgentHookEntry {
  type: "agent";
  matcher: string;
  prompt: string;
  command: string;
  timeout?: number;
  model?: string;
}

export interface HttpHookEntry {
  type: "http";
  matcher: string;
  url: string;
  command: string;
  timeout?: number;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
}

export type HookEntry = CommandHookEntry | PromptHookEntry | AgentHookEntry | HttpHookEntry;

export function isCommandHook(entry: HookEntry): entry is CommandHookEntry {
  return entry.type === undefined || entry.type === "command";
}

export function isPromptHook(entry: HookEntry): entry is PromptHookEntry {
  return entry.type === "prompt";
}

export function isAgentHook(entry: HookEntry): entry is AgentHookEntry {
  return entry.type === "agent";
}

export function isHttpHook(entry: HookEntry): entry is HttpHookEntry {
  return entry.type === "http";
}
