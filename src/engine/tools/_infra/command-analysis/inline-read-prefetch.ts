import { readFile, stat } from "node:fs/promises";
import { splitCommandParts } from "@/engine/tools/_infra/command-analysis/commands.ts";
import { tokenizeSegment, unquote } from "@/engine/tools/_infra/command-analysis/shell-tokens.ts";

const DEFAULT_HEAD_LINES = 10;
const DEFAULT_TAIL_LINES = 10;
const MAX_PREFETCH_FILE_SIZE = 10_485_760;

const SED_RANGE_REGEX = /^(\d+),(\d+)p$/;
const SED_SINGLE_REGEX = /^(\d+)p$/;
const SAFE_NOOP_SEGMENT_REGEX = /^\s*(echo|printf|true|:)\b/;
const GLOB_CHAR_REGEX = /[*?[{]/;
const DIGITS_REGEX = /^\d+$/;

const FILE_PRINT_COMMAND_FLAGS = new Map<string, Set<string>>([
  ["cat", new Set(["-n", "--number"])],
  ["nl", new Set()],
  ["bat", new Set(["-n", "--number", "-p", "--plain"])],
  ["batcat", new Set(["-n", "--number", "-p", "--plain"])],
]);

const GREP_SHORT_FLAG_REGEX = /^-[niwxEFGPHh]+$/;
const GREP_CONTEXT_SHORT_FLAG_REGEX = /^-[ABC]\d+$/;
const GREP_CONTEXT_LONG_FLAG_REGEX = /^--(?:after-context|before-context|context)=\d+$/;
const GREP_SAFE_LONG_FLAGS = new Set([
  "--line-number",
  "--ignore-case",
  "--word-regexp",
  "--line-regexp",
  "--extended-regexp",
  "--fixed-strings",
  "--basic-regexp",
  "--perl-regexp",
  "--with-filename",
  "--no-filename",
  "--color=never",
  "--color=auto",
]);

const RIPGREP_SHORT_FLAG_REGEX = /^-[iSswxFnNHUP]+$/;
const RIPGREP_CONTEXT_SHORT_FLAG_REGEX = /^-[ABC]\d+$/;
const RIPGREP_CONTEXT_LONG_FLAG_REGEX = /^--(?:after-context|before-context|context)=\d+$/;
const RIPGREP_SAFE_LONG_FLAGS = new Set([
  "--ignore-case",
  "--smart-case",
  "--case-sensitive",
  "--word-regexp",
  "--line-regexp",
  "--fixed-strings",
  "--line-number",
  "--no-line-number",
  "--with-filename",
  "--no-filename",
  "--multiline",
  "--pcre2",
]);

export interface InlinePrefetchEntry {
  filePath: string;
  startLine?: number;
  endLine?: number;
  tailLines?: number;
  requiresExitZero?: boolean;
}

export interface PrefetchedRead {
  content: string;
  offset?: number;
  limit?: number;
}

export function parseInlineReadCommands(command: string): InlinePrefetchEntry[] {
  if (/[|<>]/.test(command)) return [];
  const segments = splitCommandParts(command);
  if (segments.length === 0) return [];
  const out: InlinePrefetchEntry[] = [];
  for (const segment of segments) {
    const tokens = tokenizeSegment(segment);
    const parsed =
      parseSed(tokens) ??
      parseCat(tokens) ??
      parseHead(tokens) ??
      parseTail(tokens) ??
      (segments.length === 1 ? (parseGrep(tokens) ?? parseRipgrep(tokens)) : null);
    if (parsed) {
      out.push(parsed);
    } else if (segments.length > 1 && !SAFE_NOOP_SEGMENT_REGEX.test(segment)) {
      return [];
    }
  }
  return out;
}

function parseSed(tokens: string[]): InlinePrefetchEntry | null {
  if (tokens[0] !== "sed") return null;
  let quiet = false;
  let script: string | null = null;
  let filePath: string | null = null;
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    if (tok.startsWith("-")) {
      if (tok.startsWith("--")) {
        if (tok === "--in-place" || tok.startsWith("--in-place=")) return null;
        if (tok === "--expression") return null;
        if (tok === "--quiet" || tok === "--silent") quiet = true;
      } else {
        if (tok.includes("i")) return null;
        if (tok === "-e") return null;
        if (tok.includes("n")) quiet = true;
      }
      continue;
    }
    if (script === null) script = unquote(tok);
    else if (filePath === null) filePath = unquote(tok);
    else return null;
  }
  if (!quiet || script === null || filePath === null) return null;
  const range = SED_RANGE_REGEX.exec(script);
  if (range) return { filePath, startLine: Number(range[1]), endLine: Number(range[2]) };
  const single = SED_SINGLE_REGEX.exec(script);
  if (single) {
    const line = Number(single[1]);
    return { filePath, startLine: line, endLine: line };
  }
  return null;
}

function parseCat(tokens: string[]): InlinePrefetchEntry | null {
  const allowedFlags = FILE_PRINT_COMMAND_FLAGS.get(tokens[0] ?? "");
  if (allowedFlags === undefined) return null;
  let filePath: string | null = null;
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    if (tok.startsWith("-")) {
      if (!allowedFlags.has(tok)) return null;
      continue;
    }
    if (filePath !== null) return null;
    filePath = unquote(tok);
  }
  if (filePath === null || filePath === "-") return null;
  return { filePath };
}

function parseGrep(tokens: string[]): InlinePrefetchEntry | null {
  if (tokens[0] !== "grep" && tokens[0] !== "egrep" && tokens[0] !== "fgrep") return null;
  let pattern: string | null = null;
  let filePath: string | null = null;
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    if (tok.startsWith("-") && tok !== "-") {
      if (tok === "-A" || tok === "-B" || tok === "-C") {
        const next = tokens[++i];
        if (next === undefined || !DIGITS_REGEX.test(next)) return null;
        continue;
      }
      if (
        GREP_CONTEXT_LONG_FLAG_REGEX.test(tok) ||
        GREP_CONTEXT_SHORT_FLAG_REGEX.test(tok) ||
        GREP_SHORT_FLAG_REGEX.test(tok) ||
        GREP_SAFE_LONG_FLAGS.has(tok)
      ) {
        continue;
      }
      return null;
    }
    if (pattern === null) pattern = unquote(tok);
    else if (filePath === null) filePath = unquote(tok);
    else return null;
  }
  if (pattern === null || filePath === null || filePath === "-") return null;
  if (GLOB_CHAR_REGEX.test(filePath)) return null;
  return { filePath, requiresExitZero: true };
}

function parseRipgrep(tokens: string[]): InlinePrefetchEntry | null {
  if (tokens[0] !== "rg") return null;
  let pattern: string | null = null;
  let filePath: string | null = null;
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    if (tok.startsWith("-") && tok !== "-") {
      if (tok === "-A" || tok === "-B" || tok === "-C") {
        const next = tokens[++i];
        if (next === undefined || !DIGITS_REGEX.test(next)) return null;
        continue;
      }
      if (tok === "--after-context" || tok === "--before-context" || tok === "--context") {
        const next = tokens[++i];
        if (next === undefined || !DIGITS_REGEX.test(next)) return null;
        continue;
      }
      if (
        RIPGREP_CONTEXT_LONG_FLAG_REGEX.test(tok) ||
        RIPGREP_CONTEXT_SHORT_FLAG_REGEX.test(tok) ||
        RIPGREP_SHORT_FLAG_REGEX.test(tok) ||
        RIPGREP_SAFE_LONG_FLAGS.has(tok)
      ) {
        continue;
      }
      return null;
    }
    if (pattern === null) pattern = unquote(tok);
    else if (filePath === null) filePath = unquote(tok);
    else return null;
  }
  if (pattern === null || filePath === null || filePath === "-") return null;
  if (GLOB_CHAR_REGEX.test(filePath)) return null;
  return { filePath, requiresExitZero: true };
}

function parseLineCountFlag(
  tokens: string[],
  fallback: number,
): { count: number; filePath: string } | null {
  let count: number | null = null;
  let filePath: string | null = null;
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    if (tok === "-n" || tok === "--lines") {
      const next = tokens[++i];
      if (next === undefined || !DIGITS_REGEX.test(next)) return null;
      count = Number(next);
      continue;
    }
    if (tok.startsWith("--lines=")) {
      const value = tok.slice(8);
      if (!DIGITS_REGEX.test(value)) return null;
      count = Number(value);
      continue;
    }
    if (/^-n\d+$/.test(tok)) {
      count = Number(tok.slice(2));
      continue;
    }
    if (/^-\d+$/.test(tok)) {
      count = Number(tok.slice(1));
      continue;
    }
    if (tok.startsWith("-")) return null;
    if (filePath !== null) return null;
    filePath = unquote(tok);
  }
  if (filePath === null || filePath === "-") return null;
  if (count === 0) return null;
  return { count: count ?? fallback, filePath };
}

function parseHead(tokens: string[]): InlinePrefetchEntry | null {
  if (tokens[0] !== "head") return null;
  const parsed = parseLineCountFlag(tokens, DEFAULT_HEAD_LINES);
  if (parsed === null) return null;
  return { filePath: parsed.filePath, startLine: 1, endLine: parsed.count };
}

function parseTail(tokens: string[]): InlinePrefetchEntry | null {
  if (tokens[0] !== "tail") return null;
  const parsed = parseLineCountFlag(tokens, DEFAULT_TAIL_LINES);
  if (parsed === null) return null;
  return { filePath: parsed.filePath, tailLines: parsed.count };
}

export async function loadInlineRead(
  absolutePath: string,
  entry: InlinePrefetchEntry,
  signal: AbortSignal | undefined,
): Promise<PrefetchedRead | null> {
  try {
    const stats = await stat(absolutePath);
    if (stats.size > MAX_PREFETCH_FILE_SIZE) return null;
    if (signal?.aborted === true) return null;
    const fullContent = await readFile(absolutePath, { encoding: "utf8" });
    if (entry.tailLines !== undefined) {
      const lines = fullContent.split("\n");
      if (lines.length > 0 && lines.at(-1) === "") lines.pop();
      if (lines.length === 0) return null;
      const sliceLen = Math.min(entry.tailLines, lines.length);
      const startIdx = lines.length - sliceLen + 1;
      return { content: lines.slice(startIdx - 1).join("\n"), offset: startIdx, limit: sliceLen };
    }
    if (entry.startLine === undefined) return { content: fullContent };
    const lines = fullContent.split("\n");
    const startLine = Math.max(1, entry.startLine);
    const endLine = Math.max(startLine, entry.endLine ?? startLine);
    if (startLine > lines.length) return null;
    return {
      content: lines.slice(startLine - 1, endLine).join("\n"),
      offset: startLine,
      limit: endLine - startLine + 1,
    };
  } catch {
    return null;
  }
}
