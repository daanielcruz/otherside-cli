import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { listRunning as bgListRunning } from "@/engine/background/tasks/background.ts";
import { estimateFileTokens } from "@/engine/session/compact/token-count.ts";
import { formatNumberedLines } from "@/engine/tools/builtins/read/read.ts";
import { MAIN_SCOPE, readSetEntries } from "@/engine/tools/builtins/read/state.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";
import { isPreservedImageBlock, type PreservedImageEntry } from "./preserved-image-ledger.ts";

const POST_COMPACT_MAX_FILES = 5;
const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000;
const POST_COMPACT_TOKEN_BUDGET = 50_000;
// Cap images carried across compaction. Without it every compaction re-collects
// the full image set and re-injects it, so the post-compact baseline grows
// monotonically — that drives rapid context refill, trips the rapid-refill
// breaker, and disables auto-compaction for the rest of the session.
export const POST_COMPACT_MAX_IMAGES = 5;

const MEMORY_FILE_BASENAMES = new Set(["OTHERSIDE.md"]);

function isExcludedFromCompactRestore(path: string): boolean {
  return MEMORY_FILE_BASENAMES.has(basename(path));
}

export interface RestoredFile {
  path: string;
  numLines: number;
}

export interface PostCompactRehydration {
  blocks: ContentBlock[];
  restoredFiles: RestoredFile[];
}

export function collectImageBlocks(messages: { content: ContentBlock[] }[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "image") out.push(block);
    }
  }
  return out;
}

export function buildPostCompactRehydration(
  permissionMode: string,
  preservedImages: PreservedImageEntry[] = [],
): PostCompactRehydration {
  const blocks: ContentBlock[] = [];
  const recent = recentFilesRehydration();
  if (recent) blocks.push(recent.block);
  const bgInventory = buildBgAgentInventoryBlock();
  if (bgInventory) blocks.push({ type: "text", text: bgInventory });
  if (permissionMode === "plan") {
    blocks.push({
      type: "text",
      text: "<plan-mode>active — propose changes via ExitPlanMode before editing files.</plan-mode>",
    });
  }
  // Unresolved references never reach the model: only full image blocks pass.
  const fullImages = preservedImages.filter(isPreservedImageBlock);
  const keptImages =
    fullImages.length > POST_COMPACT_MAX_IMAGES
      ? fullImages.slice(-POST_COMPACT_MAX_IMAGES)
      : fullImages;
  if (keptImages.length > 0) {
    blocks.push({
      type: "text",
      text: `<preserved-images count="${keptImages.length}">images carried forward from the pre-compact context</preserved-images>`,
    });
    for (const img of keptImages) blocks.push(img);
  }
  return { blocks, restoredFiles: recent?.restoredFiles ?? [] };
}

function recentFilesRehydration(): { block: ContentBlock; restoredFiles: RestoredFile[] } | null {
  let entries: { path: string; mtime: number }[];
  try {
    entries = readSetEntries(MAIN_SCOPE);
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  const sorted = entries
    .filter((entry) => !isExcludedFromCompactRestore(entry.path))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, POST_COMPACT_MAX_FILES);
  if (sorted.length === 0) return null;
  const sections: string[] = [];
  const restoredFiles: RestoredFile[] = [];
  let tokenBudget = POST_COMPACT_TOKEN_BUDGET;
  for (const entry of sorted) {
    const body = readEntryBody(entry.path, tokenBudget);
    const fileExtension = extname(entry.path).slice(1).toLowerCase();
    tokenBudget -= estimateFileTokens(body, fileExtension);
    sections.push(`<file path="${entry.path}">\n${body}\n</file>`);
    restoredFiles.push({ path: entry.path, numLines: countLines(entry.path) });
    if (tokenBudget <= 0) break;
  }
  return {
    block: {
      type: "text",
      text: `<post-compact-rehydration>\n<files-recently-read>\n${sections.join("\n")}\n</files-recently-read>\n</post-compact-rehydration>`,
    },
    restoredFiles,
  };
}

function countLines(path: string): number {
  try {
    return readFileSync(path, "utf8").split("\n").length;
  } catch {
    return 0;
  }
}

function readEntryBody(path: string, tokenBudget: number): string {
  try {
    const raw = readFileSync(path, "utf8");
    const fileExtension = extname(path).slice(1).toLowerCase();
    const tokenCap = Math.min(POST_COMPACT_MAX_TOKENS_PER_FILE, tokenBudget);
    const estimatedTokens = estimateFileTokens(raw, fileExtension);
    if (estimatedTokens <= tokenCap) return formatNumberedLines(raw).output;
    const charCap = Math.max(0, Math.round((raw.length * tokenCap) / estimatedTokens));
    const sliced = formatNumberedLines(raw.slice(0, charCap)).output;
    return `${sliced}…(truncated)`;
  } catch {
    return "(file no longer readable)";
  }
}

function buildBgAgentInventoryBlock(): string | null {
  try {
    const running = bgListRunning();
    if (running.length === 0) return null;
    const lines = running.map(
      (t) => `- ${t.kind} ${t.id}: ${t.agentName}${t.description ? ` — ${t.description}` : ""}`,
    );
    return `<task-status>\nBackground tasks running:\n${lines.join("\n")}\n</task-status>`;
  } catch {
    return null;
  }
}
