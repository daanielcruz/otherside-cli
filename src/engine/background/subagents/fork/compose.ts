import { readFileSync } from "node:fs";
import {
  buildSubagentEnvTail,
  SUBAGENT_NOTES,
} from "@/engine/background/subagents/fork/env-tail.ts";
import { isAllowedInForkDeclarations } from "@/engine/background/subagents/fork/tool-gates.ts";
import type { ForkSpec } from "@/engine/background/subagents/fork/types.ts";
import {
  defaultComposeForkSystem,
  defaultComposeForkUserBlock,
} from "@/engine/contract/defaults/fork-compose.ts";
import { getProviderConfig } from "@/engine/contract/registry.ts";
import * as providers from "@/engine/providers/registry.ts";
import { deferredCatalogFor } from "@/engine/tools/deferred.ts";
import * as toolRegistry from "@/engine/tools/registry.ts";
import { midSystemPromotionFor } from "@/engine/translator/assemble.ts";
import type { ProviderToolDeclaration } from "@/engine/translator/index.ts";
import { stripSystemReminderWrapper } from "@/harness/composer/reminder-wrapper.ts";
import { renderDeferredToolsReminder } from "@/harness/reminders/reminders.ts";
import { isMcpToolName } from "@/kernel/mcp/index.ts";
import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export function composeForkSystem(input: {
  ctx: RequestContext;
  name: string;
  body: string;
  firstPrompt: string;
  previousRequestId?: string;
}): ContentBlock[] {
  const interpolatedBody = interpolatePlatformPrompts(input.body);
  const envTail = `${SUBAGENT_NOTES}\n\n${buildSubagentEnvTail(input.ctx)}`;
  const fn = getProviderConfig(input.ctx.provider)?.composeForkSystem ?? defaultComposeForkSystem;
  return fn({
    name: input.name,
    body: interpolatedBody,
    firstPrompt: input.firstPrompt,
    envTail,
    ...(input.previousRequestId ? { previousRequestId: input.previousRequestId } : {}),
  });
}

/**
 * Announces the deferred tools this agent can load via ToolSearch — the names
 * behind its DeferredToolPlaceholder that are absent from its declared roster.
 * On models with the mid-conversation-system beta the announcement travels as
 * a promoted system message after the opening user turn (the translate funnel
 * downgrades its trailing cache ttl); elsewhere it stays a user-turn block.
 */
export function appendForkDeferredToolsReminder(
  fork: Message[],
  ctx: RequestContext,
  spec: ForkSpec,
  declarations: readonly ProviderToolDeclaration[],
): void {
  const declared = new Set(declarations.map((declaration) => declaration.name));
  const allowed = (name: string): boolean =>
    !declared.has(name) && isAllowedInForkDeclarations(name, spec.allowSet, spec, ctx.agentOwnerId);
  const provider = providers.get(ctx.provider);
  const baseNames = deferredCatalogFor(provider.deferredOverrides()).filter(allowed);
  const mcpNames = toolRegistry
    .list()
    .map((handler) => handler.schema.name)
    .filter((name) => isMcpToolName(name) && allowed(name));
  if (baseNames.length === 0 && mcpNames.length === 0) return;
  const reminder = renderDeferredToolsReminder(baseNames, new Set(), mcpNames).trim();

  const promotion = midSystemPromotionFor(ctx);
  if (promotion !== "off") {
    const text = promotion === "unwrapped" ? stripSystemReminderWrapper(reminder) : reminder;
    fork.push({ role: "system", content: [{ type: "text", text }] });
    return;
  }
  const lastUser = [...fork].reverse().find((msg) => msg.role === "user");
  if (lastUser) lastUser.content = [...lastUser.content, { type: "text", text: reminder }];
}

function isWsl(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const procVersion = readFileSync("/proc/version", "utf8");
    const lower = procVersion.toLowerCase();
    return lower.includes("microsoft") || lower.includes("wsl");
  } catch {
    return false;
  }
}

function interpolatePlatformPrompts(prompt: string): string {
  const isWindowsOrWsl = process.platform === "win32" || isWsl();
  const shellTool = isWindowsOrWsl ? "PowerShell" : "Bash";
  const findGuideline = isWindowsOrWsl
    ? "- Use Glob for broad file pattern matching"
    : "- Use `find` via Bash for broad file pattern matching";
  const grepGuideline = isWindowsOrWsl
    ? "- Use Grep for searching file contents with regex"
    : "- Use `grep` via Bash for searching file contents with regex";
  const readOnlyCmds = isWindowsOrWsl
    ? "Get-ChildItem, git status, git log, git diff, Get-Content, Select-Object -First/-Last"
    : "ls, git status, git log, git diff, find, grep, cat, head, tail";
  const blockedCmds = isWindowsOrWsl
    ? "New-Item, Remove-Item, Copy-Item, Move-Item, git add, git commit, npm install, pip install"
    : "mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install";
  const searchToolsHint = isWindowsOrWsl
    ? "Glob, Grep, and Read"
    : "Bash (`find`, `grep`, `rg`) and Read";

  return prompt
    .replaceAll("{{shellTool}}", shellTool)
    .replaceAll("{{findGuideline}}", findGuideline)
    .replaceAll("{{grepGuideline}}", grepGuideline)
    .replaceAll("{{readOnlyCmds}}", readOnlyCmds)
    .replaceAll("{{blockedCmds}}", blockedCmds)
    .replaceAll("{{searchToolsHint}}", searchToolsHint);
}

export function composeForkUserBlock(providerId: ProviderId, prompt: string): ContentBlock {
  const fn = getProviderConfig(providerId)?.composeForkUserBlock ?? defaultComposeForkUserBlock;
  return fn(prompt);
}
