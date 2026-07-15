import type { ParsedHookEntry, ParsedHooks } from "@/engine/agents/frontmatter.ts";
import type { HookEvent } from "@/kernel/hooks/events.ts";
import type { HookEntry } from "@/kernel/hooks/exec.ts";
import { fireHookEntries, handlersFromHookMap } from "@/kernel/hooks/handler.ts";
import type { HookHandler } from "@/kernel/hooks/index.ts";
import { addSessionHook, listSessionHooks } from "@/kernel/hooks/session-registry.ts";

const HOOK_EVENTS: ReadonlySet<string> = new Set([
  "preToolUse",
  "postToolUse",
  "userPromptSubmit",
  "stop",
  "subagentStart",
  "subagentStop",
  "preCompact",
  "postCompact",
]);

export function registerAgentHooks(
  forkId: string,
  _sessionId: string,
  hooks: ParsedHooks | null | undefined,
  via: string,
): HookHandler[] {
  if (!hooks) return [];
  const byEvent: Partial<Record<HookEvent, HookEntry[]>> = {};
  for (const [rawEvent, parsedEntries] of Object.entries(hooks)) {
    const event = (rawEvent === "stop" ? "subagentStop" : rawEvent) as HookEvent;
    if (!HOOK_EVENTS.has(event)) continue;
    for (const parsed of parsedEntries) {
      const entry = hookEntryFromParsed(parsed);
      if (!entry) continue;
      addSessionHook(forkId, event, { entry, via });
      const list = byEvent[event] ?? [];
      list.push(entry);
      byEvent[event] = list;
    }
  }
  return handlersFromHookMap(byEvent);
}

export function taskHooksFromParsed(hooks: ParsedHooks | null | undefined): {
  created: HookEntry[];
  completed: HookEntry[];
} {
  const created: HookEntry[] = [];
  const completed: HookEntry[] = [];
  if (hooks) {
    for (const parsed of hooks.taskCreated ?? []) {
      const entry = hookEntryFromParsed(parsed);
      if (entry) created.push(entry);
    }
    for (const parsed of hooks.taskCompleted ?? []) {
      const entry = hookEntryFromParsed(parsed);
      if (entry) completed.push(entry);
    }
  }
  return { created, completed };
}

function hookEntryFromParsed(parsed: ParsedHookEntry): HookEntry | null {
  if (parsed.type === "prompt") {
    if (!parsed.prompt) return null;
    return {
      type: "prompt",
      matcher: parsed.matcher,
      prompt: parsed.prompt,
      ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
    };
  }
  if (!parsed.command) return null;
  return {
    matcher: parsed.matcher,
    command: parsed.command,
    ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
  };
}

export async function fireSubagentStartHooks(
  forkId: string,
  sessionId: string,
  agentType: string,
): Promise<void> {
  const entries = listSessionHooks(forkId, "subagentStart").map((e) => e.entry);
  if (entries.length === 0) return;
  try {
    await fireHookEntries(entries, {
      kind: "subagentStart",
      ctx: { sessionId, subagentId: forkId, agentType },
    });
  } catch {}
}

export async function fireSubagentStopHooks(forkId: string, sessionId: string): Promise<void> {
  const entries = listSessionHooks(forkId, "subagentStop").map((e) => e.entry);
  if (entries.length === 0) return;
  try {
    await fireHookEntries(entries, {
      kind: "subagentStop",
      ctx: { sessionId, subagentId: forkId },
    });
  } catch {}
}
