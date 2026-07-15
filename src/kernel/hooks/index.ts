import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { DEFAULT_TIMEOUT_MS } from "./constants.ts";
import type { EventCtx, HookEvent } from "./events.ts";
import { fireEntry, type HookEntry, type HookOutcome } from "./exec.ts";

export type { EventCtx, HookEvent } from "./events.ts";
export { HOOK_EVENT_VALUES } from "./events.ts";
export type { HookEntry, HookOutcome } from "./exec.ts";
export { fireEntry } from "./exec.ts";

export interface HookHandler {
  // A bare `ToolCall` return means the hook chain expressed no explicit
  // allow/ask permissionDecision for this call (the pre-existing default:
  // permission resolution proceeds unchanged, possibly against a rewritten
  // input). `{ kind: "allow" | "ask", call }` carries an explicit
  // hookSpecificOutput.permissionDecision through to permission resolution
  // (see pretooluse-hook-permission-context.ts) so it can bypass or force the
  // interactive/headless prompt, mirroring upstream's resolveHookPermissionDecision.
  preToolUse?(
    call: ToolCall,
    ctx: RequestContext,
  ): Promise<
    | ToolCall
    | { kind: "allow"; call: ToolCall }
    | { kind: "ask"; call: ToolCall }
    | "block"
    | { kind: "block"; reason: string }
  >;
  postToolUse?(call: ToolCall, result: ToolResult, ctx: RequestContext): Promise<ToolResult>;
}

export interface HooksConfig {
  hooks: Partial<Record<HookEvent, HookEntry[]>>;
}

export async function fireFor(
  cfg: HooksConfig,
  event: HookEvent,
  ctx: EventCtx,
): Promise<HookOutcome[]> {
  const entries = cfg.hooks[event] ?? [];
  const out: HookOutcome[] = [];
  for (const entry of entries) {
    const t = entry.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    out.push(await fireEntry(entry, ctx, t));
  }
  return out;
}
