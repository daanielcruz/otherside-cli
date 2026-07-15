import { readFileSync } from "node:fs";
import {
  buildSubagentEnvTail,
  SUBAGENT_NOTES,
} from "@/engine/background/subagents/fork/env-tail.ts";
import {
  defaultComposeForkSystem,
  defaultComposeForkUserBlock,
} from "@/engine/contract/defaults/fork-compose.ts";
import { getProviderConfig } from "@/engine/contract/registry.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";
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
