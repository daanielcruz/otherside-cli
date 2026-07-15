import type { Message, ToolResultContentBlock } from "@/kernel/std/types/message.ts";
import { roughTokenCountEstimationForToolResult } from "./token-count.ts";

export const MICRO_COMPACT_CLEARED_MESSAGE = "[Old tool result content cleared]";

const COMPACTABLE_TOOLS = new Set<string>([
  "Read",
  "Bash",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
  "Edit",
  "Write",
]);

export type MicroCompactMode = "token" | "time" | "both";

export interface MicroCompactConfig {
  enabled: boolean;
  mode?: MicroCompactMode;
  keepRecent: number;
  triggerRatio: number;
  gapThresholdMinutes?: number;
}

const DEFAULT_KEEP_RECENT = 5;
const DEFAULT_TRIGGER_RATIO = 0.85;
const DEFAULT_GAP_THRESHOLD_MINUTES = 60;

function microCompactModeFromEnv(enableEnv: string): MicroCompactMode {
  if (enableEnv === "token") return "token";
  if (enableEnv === "time") return "time";
  return "both";
}

export function getMicroCompactConfig(): MicroCompactConfig {
  const enableEnv = process.env.OTHERSIDE_MICROCOMPACT ?? "";
  const disabled = !!process.env.OTHERSIDE_DISABLE_MICROCOMPACT;
  const enabled =
    !disabled &&
    (enableEnv === "1" || enableEnv === "true" || enableEnv === "token" || enableEnv === "time");
  const mode: MicroCompactMode = microCompactModeFromEnv(enableEnv);
  const keep = Number.parseInt(process.env.OTHERSIDE_MICROCOMPACT_KEEP ?? "", 10);
  const ratio = Number.parseFloat(process.env.OTHERSIDE_MICROCOMPACT_RATIO ?? "");
  const gap = Number.parseInt(process.env.OTHERSIDE_MICROCOMPACT_GAP_MIN ?? "", 10);
  return {
    enabled,
    mode,
    keepRecent: Number.isFinite(keep) && keep > 0 ? keep : DEFAULT_KEEP_RECENT,
    triggerRatio: Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : DEFAULT_TRIGGER_RATIO,
    gapThresholdMinutes: Number.isFinite(gap) && gap > 0 ? gap : DEFAULT_GAP_THRESHOLD_MINUTES,
  };
}

interface ToolUseRef {
  id: string;
  name: string;
}

function collectCompactableToolUses(messages: Message[]): ToolUseRef[] {
  const out: ToolUseRef[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && COMPACTABLE_TOOLS.has(block.name)) {
        out.push({ id: block.id, name: block.name });
      }
    }
  }
  return out;
}

export interface MicroCompactOutcome {
  cleared: number;
  kept: number;
  tokensSavedEstimate: number;
  clearedToolUseIds: string[];
}

function clearStaleToolResults(args: {
  messages: Message[];
  uses: ToolUseRef[];
  keepRecent: number;
}): MicroCompactOutcome | null {
  if (args.uses.length <= args.keepRecent) return null;

  const keepRecent = Math.max(1, args.keepRecent);
  const keepSet = new Set(args.uses.slice(-keepRecent).map((u) => u.id));
  const clearSet = new Set(args.uses.filter((u) => !keepSet.has(u.id)).map((u) => u.id));
  if (clearSet.size === 0) return null;

  let cleared = 0;
  let tokensSaved = 0;
  const clearedToolUseIds: string[] = [];
  for (const msg of args.messages) {
    if (msg.role !== "user") continue;
    for (let i = 0; i < msg.content.length; i++) {
      const block = msg.content[i];
      if (!block || block.type !== "tool_result") continue;
      if (!clearSet.has(block.tool_use_id)) continue;
      const currentText =
        typeof block.content === "string" ? block.content : extractText(block.content);
      if (currentText === MICRO_COMPACT_CLEARED_MESSAGE) continue;
      tokensSaved += roughTokenCountEstimationForToolResult(block);
      msg.content[i] = {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: MICRO_COMPACT_CLEARED_MESSAGE,
        ...(block.is_error ? { is_error: true } : {}),
      };
      cleared += 1;
      clearedToolUseIds.push(block.tool_use_id);
    }
  }
  if (cleared === 0) return null;
  return { cleared, kept: keepSet.size, tokensSavedEstimate: tokensSaved, clearedToolUseIds };
}

export function applyTokenBasedMicroCompact(args: {
  messages: Message[];
  usedTokens: number;
  threshold: number;
  config?: MicroCompactConfig;
}): MicroCompactOutcome | null {
  const config = args.config ?? getMicroCompactConfig();
  if (!config.enabled) return null;
  if (config.mode === "time") return null;
  if (args.threshold <= 0) return null;
  const ratio = args.usedTokens / args.threshold;
  if (ratio < config.triggerRatio) return null;

  const uses = collectCompactableToolUses(args.messages);
  return clearStaleToolResults({
    messages: args.messages,
    uses,
    keepRecent: config.keepRecent,
  });
}

function extractText(content: ToolResultContentBlock[] | string): string {
  if (typeof content === "string") return content;
  let out = "";
  for (const block of content) {
    if (block.type === "text") out += block.text;
  }
  return out;
}

export function applyTimeBasedMicroCompact(args: {
  messages: Message[];
  lastAssistantTs: number;
  now?: number;
  config?: MicroCompactConfig;
}): MicroCompactOutcome | null {
  const config = args.config ?? getMicroCompactConfig();
  if (!config.enabled) return null;
  if (config.mode === "token") return null;
  const now = args.now ?? Date.now();
  const gapMinutes = config.gapThresholdMinutes ?? DEFAULT_GAP_THRESHOLD_MINUTES;
  const gapMs = gapMinutes * 60_000;
  if (now - args.lastAssistantTs < gapMs) return null;

  const uses = collectCompactableToolUses(args.messages);
  return clearStaleToolResults({
    messages: args.messages,
    uses,
    keepRecent: config.keepRecent,
  });
}
