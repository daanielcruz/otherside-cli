import { basename } from "node:path";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { ToolResult, ToolResultContentBlock } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { DEFAULT_TIMEOUT_MS } from "./constants.ts";
import type { EventCtx, FileChangedEventKind, HookEvent } from "./events.ts";
import { fireEntry, type HookEntry, type HookOutcome, isCommandHook } from "./exec.ts";
import { startFileChangedWatcher, stopFileChangedWatcher } from "./file-changed-watcher.ts";
import type { HookHandler } from "./index.ts";

type HookEntryProvider = (event: HookEvent) => HookEntry[];

let hookEntryProvider: HookEntryProvider = () => [];

export function registerHookEntryProvider(provider: HookEntryProvider): void {
  hookEntryProvider = provider;
}

function listHookEntries(event: HookEvent): HookEntry[] {
  return hookEntryProvider(event);
}

export function _resetHookEntryProviderForTests(): void {
  hookEntryProvider = () => [];
}

export function handlersFromConfig(config: UserConfig): HookHandler[] {
  const hooks = config.hooks;
  if (!hooks || Object.keys(hooks).length === 0) return [];
  return handlersFromHookMap(hooks);
}

export function handlersFromHookMap(hooks: Partial<Record<HookEvent, HookEntry[]>>): HookHandler[] {
  if (Object.keys(hooks).length === 0) return [];
  return [
    {
      async preToolUse(call) {
        const outcomes = await fireMatchingHooks(hooks.preToolUse ?? [], call.name, {
          kind: "preToolUse",
          ctx: { toolName: call.name, toolInput: stringifyInput(call.input) },
        });
        const decision = preToolUseDecisionFromOutcomes(outcomes);
        if (decision.action === "block") {
          return { kind: "block", reason: decision.reason };
        }
        const updatedCall =
          decision.updatedInput !== undefined ? { ...call, input: decision.updatedInput } : call;
        // An explicit hookSpecificOutput.permissionDecision of "allow" or "ask"
        // is carried through as a tagged outcome so the pipeline can thread it
        // into permission resolution (PERM-HOOK-ALLOW-BYPASS-001); a
        // decision-less passthrough keeps returning the bare call, unchanged.
        if (decision.hookPermission === "ask") return { kind: "ask", call: updatedCall };
        if (decision.hookPermission === "allow") return { kind: "allow", call: updatedCall };
        return updatedCall;
      },
      async postToolUse(call, result) {
        const outcomes = await fireMatchingHooks(hooks.postToolUse ?? [], call.name, {
          kind: "postToolUse",
          ctx: {
            toolName: call.name,
            toolInput: stringifyInput(call.input),
            toolExit: result.is_error ? 1 : 0,
          },
        });
        return appendPostToolUseFeedback(result, postToolUseHookFeedback(outcomes));
      },
    },
  ];
}

export async function fireHookEntries(entries: HookEntry[], ctx: EventCtx): Promise<HookOutcome[]> {
  return fireAll(entries, ctx);
}

export interface PromptHookResult {
  outcomes: HookOutcome[];
  additionalContext: string[];
}

export interface PermissionDeniedSpecificOutput {
  hookEventName: "PermissionDenied";
  retry?: boolean;
}

export interface PermissionDeniedHookResult {
  outcomes: HookOutcome[];
  retry: boolean;
}

export async function fireUserPromptSubmitHooks(
  config: UserConfig,
  promptText: string,
): Promise<PromptHookResult> {
  const pluginEntries = listHookEntries("userPromptSubmit");

  const outcomes = await fireAll([...(config.hooks?.userPromptSubmit ?? []), ...pluginEntries], {
    kind: "userPromptSubmit",
    ctx: { promptText },
  });
  return { outcomes, additionalContext: additionalContextFromOutcomes(outcomes) };
}

export async function firePermissionDeniedHooks(
  config: UserConfig,
  ctx: Extract<EventCtx, { kind: "permissionDenied" }>,
): Promise<PermissionDeniedHookResult> {
  const outcomes = await fireConfiguredHooks(config, "permissionDenied", ctx);
  return { outcomes, retry: permissionDeniedRetryFromOutcomes(outcomes) };
}

export function fireSetupHooksInBackground(
  config: UserConfig,
  trigger: Extract<EventCtx, { kind: "Setup" }>["ctx"]["trigger"] = "init",
): void {
  queueMicrotask(() => {
    try {
      void fireConfiguredHooks(config, "Setup", {
        kind: "Setup",
        ctx: { hook_event_name: "Setup", trigger },
      }).catch(() => {});
    } catch {}
  });
}

export async function fireConfiguredHooks(
  config: UserConfig,
  event: HookEvent,
  ctx: EventCtx,
): Promise<HookOutcome[]> {
  const pluginEntries = listHookEntries(event);
  const outcomes = await fireAll([...(config.hooks?.[event] ?? []), ...pluginEntries], ctx);

  if (event === "sessionStart" && ctx.kind === "sessionStart") {
    const fileChangedEntries = [
      ...(config.hooks?.FileChanged ?? []),
      ...listHookEntries("FileChanged"),
    ];
    startFileChangedWatcher({
      cwd: ctx.ctx.cwd,
      config: { hooks: { ...config.hooks, FileChanged: fileChangedEntries } },
      fire: (filePath, changeEvent) => {
        fireFileChangedHooksInBackground(config, filePath, changeEvent);
      },
    });
  } else if (event === "sessionEnd") {
    stopFileChangedWatcher();
  }

  return outcomes;
}

export function fireFileChangedHooksInBackground(
  config: UserConfig,
  filePath: string,
  event: FileChangedEventKind,
): void {
  queueMicrotask(() => {
    try {
      void fireFileChangedHooks(config, filePath, event).catch(() => {});
    } catch {}
  });
}

export async function fireFileChangedHooks(
  config: UserConfig,
  filePath: string,
  event: FileChangedEventKind,
): Promise<HookOutcome[]> {
  const entries = [...(config.hooks?.FileChanged ?? []), ...listHookEntries("FileChanged")];
  return fireAll(
    entries.filter((entry) => matches(entry.matcher, basename(filePath))),
    {
      kind: "FileChanged",
      ctx: { hook_event_name: "FileChanged", file_path: filePath, event },
    },
  );
}

/**
 * WorktreeCreate: first nonempty stdout line across successful outcomes is the
 * path (replaces default git worktree add when present).
 */
export async function fireWorktreeCreateHooks(
  config: UserConfig,
  name: string,
): Promise<HookOutcome[]> {
  return fireConfiguredHooks(config, "WorktreeCreate", {
    kind: "WorktreeCreate",
    ctx: { hook_event_name: "WorktreeCreate", name },
  });
}

export async function fireWorktreeRemoveHooks(
  config: UserConfig,
  worktreePath: string,
): Promise<HookOutcome[]> {
  return fireConfiguredHooks(config, "WorktreeRemove", {
    kind: "WorktreeRemove",
    ctx: { hook_event_name: "WorktreeRemove", worktree_path: worktreePath },
  });
}

function additionalContextFromOutcomes(outcomes: HookOutcome[]): string[] {
  const out: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind !== "ok") continue;
    const ctx = additionalContextFromStdout(outcome.stdout);
    if (ctx) out.push(ctx);
  }
  return out;
}

function additionalContextFromStdout(stdout: string): string | null {
  const parsed = jsonObjectFromStdout(stdout);
  if (!parsed) return null;
  const value = parsed.additionalContext;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export type PreToolUseHookDecision =
  | { action: "allow"; updatedInput?: unknown; hookPermission?: "allow" | "ask" }
  | { action: "block"; reason: string };

interface PreToolUseJsonDecision {
  decision: "allow" | "deny" | "ask" | undefined;
  reason: string | undefined;
  updatedInput: unknown;
}

const DEFAULT_HOOK_BLOCK_REASON = "Blocked by hook";

// Parses a single successful hook's stdout into a PreToolUse decision: the
// top-level {decision:"approve"|"block"} shorthand is applied first, then the
// hookSpecificOutput.permissionDecision
// ("allow"|"deny"|"ask") overrides it when present and scoped to PreToolUse.
// updatedInput is captured whenever present, regardless of decision, so a pure
// input rewrite with no explicit decision (passthrough) still applies.
function preToolUseJsonDecision(stdout: string): PreToolUseJsonDecision | null {
  const parsed = jsonObjectFromStdout(stdout);
  if (!parsed) return null;

  let decision: "allow" | "deny" | "ask" | undefined;
  let reason: string | undefined;
  let updatedInput: unknown;

  if (parsed.decision === "approve") decision = "allow";
  else if (parsed.decision === "block") decision = "deny";
  if (typeof parsed.reason === "string") reason = parsed.reason;

  const hookSpecificOutput = parsed.hookSpecificOutput;
  if (isObject(hookSpecificOutput) && hookSpecificOutput.hookEventName === "PreToolUse") {
    const permissionDecision = hookSpecificOutput.permissionDecision;
    if (
      permissionDecision === "allow" ||
      permissionDecision === "deny" ||
      permissionDecision === "ask"
    ) {
      decision = permissionDecision;
    }
    if (typeof hookSpecificOutput.permissionDecisionReason === "string") {
      reason = hookSpecificOutput.permissionDecisionReason;
    }
    if (isObject(hookSpecificOutput.updatedInput)) {
      updatedInput = hookSpecificOutput.updatedInput;
    }
  }

  if (decision === undefined && updatedInput === undefined) return null;
  return { decision, reason, updatedInput };
}

// Aggregates every matching PreToolUse hook's outcome into one decision with a
// fixed precedence: deny always wins, ask wins over an explicit allow (which
// in turn wins over a decision-less passthrough), and a hook whose own decision
// resolves to deny never contributes updatedInput (whether from its own JSON or
// a still-pending value from an earlier ask/allow/passthrough hook). A hook
// process that fails outright (nonzero exit, timeout, spawn failure, or a blocked
// prompt-hook classification) is treated as an unconditional deny, matching the
// prior fail-closed default for hook execution errors.
//
// `hookPermission` on the "allow" action surfaces the winning explicit
// permissionDecision ("allow" or "ask"), if any, distinct from a decision-less
// passthrough (`hookPermission: undefined`). Both resolve `action: "allow"`
// here -- a hook return channel by itself cannot force or bypass an
// interactive prompt -- but callers that thread `hookPermission` into
// permission resolution (see pretooluse-hook-permission-context.ts) can: an
// explicit "allow" may bypass headless/background auto-deny once no explicit
// deny/ask rule matches, and an explicit "ask" forces the prompt even when
// mode/rules would otherwise auto-allow (PERM-HOOK-ALLOW-BYPASS-001).
export function preToolUseDecisionFromOutcomes(outcomes: HookOutcome[]): PreToolUseHookDecision {
  let rank: 0 | 1 | 2 | 3 = 0; // 0 = none, 1 = explicit allow, 2 = ask, 3 = deny
  let reason: string | undefined;
  let updatedInput: unknown;

  for (const outcome of outcomes) {
    if (outcome.kind !== "ok") {
      rank = 3;
      reason = reason ?? taskHookFeedback(outcome);
      continue;
    }

    const parsed = preToolUseJsonDecision(outcome.stdout);
    if (!parsed) continue;

    if (parsed.decision === "deny") {
      rank = 3;
      reason = parsed.reason ?? reason ?? DEFAULT_HOOK_BLOCK_REASON;
      updatedInput = undefined;
      continue;
    }

    // A hook whose own decision is deny never contributes updatedInput (handled
    // above); every other case (allow, ask, or a decision-less passthrough) does.
    if (parsed.updatedInput !== undefined) updatedInput = parsed.updatedInput;

    // "ask" outranks a plain "allow", which in turn outranks a decision-less
    // passthrough -- but never outranks "deny". A later, lower-ranked hook
    // never silently downgrades an earlier higher-ranked one.
    if (parsed.decision === "ask" && rank < 2) rank = 2;
    else if (parsed.decision === "allow" && rank < 1) rank = 1;
  }

  if (rank === 3) return { action: "block", reason: reason ?? DEFAULT_HOOK_BLOCK_REASON };
  const hookPermission = rank === 2 ? "ask" : rank === 1 ? "allow" : undefined;
  return { action: "allow", updatedInput, ...(hookPermission ? { hookPermission } : {}) };
}

export function permissionDeniedRetryFromOutcomes(outcomes: HookOutcome[]): boolean {
  return outcomes.some((outcome) => {
    if (outcome.kind !== "ok") return false;
    return permissionDeniedSpecificOutputFromStdout(outcome.stdout)?.retry === true;
  });
}

export function permissionDeniedSpecificOutputFromStdout(
  stdout: string,
): PermissionDeniedSpecificOutput | null {
  const parsed = jsonObjectFromStdout(stdout);
  const hookSpecificOutput = parsed?.hookSpecificOutput;
  if (!isObject(hookSpecificOutput)) return null;
  if (hookSpecificOutput.hookEventName !== "PermissionDenied") return null;
  const retry = hookSpecificOutput.retry;
  if (retry !== undefined && typeof retry !== "boolean") return null;
  return retry === undefined
    ? { hookEventName: "PermissionDenied" }
    : { hookEventName: "PermissionDenied", retry };
}

function jsonObjectFromStdout(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function fireMatchingHooks(
  entries: HookEntry[],
  toolName: string,
  ctx: EventCtx,
): Promise<HookOutcome[]> {
  return fireAll(
    entries.filter((entry) => matches(entry.matcher, toolName)),
    ctx,
  );
}

async function fireAll(entries: HookEntry[], ctx: EventCtx): Promise<HookOutcome[]> {
  const out: HookOutcome[] = [];
  for (const entry of entries) {
    out.push(await fireEntry(entry, ctx, entry.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  }
  return out;
}

export function matches(pattern: string, value: string): boolean {
  if (pattern === "" || pattern === "*") {
    return true;
  }
  if (/^[a-zA-Z0-9_|]+$/.test(pattern)) {
    return pattern
      .split("|")
      .map((p) => p.trim())
      .includes(value);
  }
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

function stringifyInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

export async function fireTaskHook(input: {
  event: "taskCreated" | "taskCompleted";
  ctx: RequestContext;
  taskId: string;
  subject: string;
  description: string;
}): Promise<string | null> {
  const { event, ctx, taskId, subject, description } = input;
  const taskHooks = ctx.taskHooks;
  if (!taskHooks) return null;
  const configured = event === "taskCreated" ? taskHooks.created : taskHooks.completed;
  const entries = configured.filter(isCommandHook);
  if (entries.length === 0) return null;
  const outcomes = await fireHookEntries(entries, {
    kind: event,
    ctx: { taskId, subject, description, sessionId: ctx.sessionId },
  });
  const feedback: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === "ok" || outcome.kind === "prompt_passed") continue;
    feedback.push(taskHookFeedback(outcome));
  }
  if (feedback.length === 0) return null;
  const label = event === "taskCreated" ? "TaskCreated" : "TaskCompleted";
  return `${label} hook feedback:\n${feedback.join("\n")}`;
}

// PostToolUse hooks run after the tool has already produced its ToolResult:
// a nonzero exit, timeout, or spawn failure is non-blocking feedback, not a
// reason to discard or replace what the tool actually returned. Every non-"ok"
// outcome is turned into a short feedback line surfaced alongside -- never in
// place of -- the tool's own content, appended after the tool result.
function postToolUseHookFeedback(outcomes: HookOutcome[]): string[] {
  const feedback: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === "ok" || outcome.kind === "prompt_passed") continue;
    feedback.push(taskHookFeedback(outcome));
  }
  return feedback;
}

// Appends hook feedback as an additional content block after the tool's own
// content, keeping the original ToolResult (including its is_error status)
// authoritative. Returns `result` unchanged when there is no feedback to add.
export function appendPostToolUseFeedback(result: ToolResult, feedback: string[]): ToolResult {
  if (feedback.length === 0) return result;
  const original: ToolResultContentBlock[] =
    typeof result.content === "string" ? [{ type: "text", text: result.content }] : result.content;
  const note: ToolResultContentBlock = {
    type: "text",
    text: `PostToolUse hook feedback:\n${feedback.join("\n")}`,
  };
  return { ...result, content: [...original, note] };
}

function taskHookFeedback(outcome: HookOutcome): string {
  switch (outcome.kind) {
    case "non_zero_exit": {
      const text = outcome.stderr.trim() || outcome.stdout.trim();
      return text.length > 0 ? text : `hook exited with code ${outcome.code}`;
    }
    case "timeout":
      return "hook timed out";
    case "spawn_failed":
      return `hook failed to start: ${outcome.error}`;
    case "prompt_blocked":
      return outcome.reason;
    default:
      return "hook blocked";
  }
}
