import { readFile, stat } from "node:fs/promises";
import { splitCommandParts } from "@/engine/tools/_infra/command-analysis/commands.ts";
import { tokenizeSegment, unquote } from "@/engine/tools/_infra/command-analysis/shell-tokens.ts";

const HEAD_LINE_DEFAULT = 10;
const TAIL_LINE_DEFAULT = 10;
const INLINE_READ_SIZE_CEILING = 10_485_760;

const SED_PRINT_LINES_REGEX = /^(\d+)(?:,(\d+))?p$/;
const PASSIVE_SEGMENT_REGEX = /^\s*(echo|printf|true|:)\b/;
const GLOB_SYNTAX_REGEX = /[*?[{]/;
const UNSIGNED_INTEGER_REGEX = /^\d+$/;

const FILE_VIEWER_FLAGS = new Map<string, Set<string>>([
  ["cat", new Set(["-n", "--number"])],
  ["nl", new Set()],
  ["bat", new Set(["-n", "--number", "-p", "--plain"])],
  ["batcat", new Set(["-n", "--number", "-p", "--plain"])],
]);

const COMPACT_CONTEXT_FLAG_REGEX = /^-[ABC]\d+$/;
const ASSIGNED_CONTEXT_FLAG_REGEX = /^--(?:after-context|before-context|context)=\d+$/;
const GREP_INLINE_FLAGS_REGEX = /^-[niwxEFGPHh]+$/;
const GREP_LONG_FLAGS = new Set([
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

const RIPGREP_INLINE_FLAGS_REGEX = /^-[iSswxFnNHUP]+$/;
const RIPGREP_LONG_FLAGS = new Set([
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

type InlineReadSelection =
  | { kind: "range"; firstLine: number; lastLine: number }
  | { kind: "tail"; count: number };

export interface InlineReadPlan {
  filePath: string;
  selection?: InlineReadSelection;
  onlyOnSuccess?: boolean;
}

export interface LoadedInlineRead {
  content: string;
  offset?: number;
  limit?: number;
}

export function parseEmbeddedReadCommands(command: string): InlineReadPlan[] {
  if (/[|<>]/.test(command)) return [];
  const segments = splitCommandParts(command);
  if (segments.length === 0) return [];
  const prefetchPlans: InlineReadPlan[] = [];
  for (const segment of segments) {
    const tokens = tokenizeSegment(segment);
    const readPlan =
      parseSed(tokens) ??
      parseCat(tokens) ??
      parseHead(tokens) ??
      parseTail(tokens) ??
      (segments.length === 1 ? (parseGrep(tokens) ?? parseRipgrep(tokens)) : null);
    if (readPlan) {
      prefetchPlans.push(readPlan);
    } else if (segments.length > 1 && !PASSIVE_SEGMENT_REGEX.test(segment)) {
      return [];
    }
  }
  return prefetchPlans;
}

function parseSed(tokens: string[]): InlineReadPlan | null {
  if (tokens[0] !== "sed") return null;
  let suppressDefaultOutput = false;
  let printExpression: string | null = null;
  let candidatePath: string | null = null;

  for (let index = 1; index < tokens.length; index++) {
    const argument = tokens[index] ?? "";
    if (!argument.startsWith("-")) {
      if (printExpression === null) printExpression = unquote(argument);
      else if (candidatePath === null) candidatePath = unquote(argument);
      else return null;
      continue;
    }
    if (argument.startsWith("--")) {
      if (argument === "--in-place" || argument.startsWith("--in-place=")) return null;
      if (argument === "--expression") return null;
      suppressDefaultOutput ||= argument === "--quiet" || argument === "--silent";
      continue;
    }
    if (argument.includes("i") || argument === "-e") return null;
    suppressDefaultOutput ||= argument.includes("n");
  }

  if (!suppressDefaultOutput || printExpression === null || candidatePath === null) return null;
  const printLines = SED_PRINT_LINES_REGEX.exec(printExpression);
  if (printLines === null) return null;
  const firstLine = Number(printLines[1]);
  const lastLine = Number(printLines[2] ?? printLines[1]);
  return { filePath: candidatePath, selection: { kind: "range", firstLine, lastLine } };
}

function parseCat(tokens: string[]): InlineReadPlan | null {
  const viewerFlags = FILE_VIEWER_FLAGS.get(tokens[0] ?? "");
  if (viewerFlags === undefined) return null;
  let filePath: string | null = null;
  for (let index = 1; index < tokens.length; index++) {
    const argument = tokens[index] ?? "";
    if (argument.startsWith("-")) {
      if (!viewerFlags.has(argument)) return null;
      continue;
    }
    if (filePath !== null) return null;
    filePath = unquote(argument);
  }
  if (filePath === null || filePath === "-") return null;
  return { filePath };
}

function parseGrep(tokens: string[]): InlineReadPlan | null {
  if (tokens[0] !== "grep" && tokens[0] !== "egrep" && tokens[0] !== "fgrep") return null;
  let pattern: string | null = null;
  let filePath: string | null = null;
  for (let index = 1; index < tokens.length; index++) {
    const argument = tokens[index] ?? "";
    if (argument.startsWith("-") && argument !== "-") {
      if (argument === "-A" || argument === "-B" || argument === "-C") {
        const contextValue = tokens[++index];
        if (contextValue === undefined || !UNSIGNED_INTEGER_REGEX.test(contextValue)) return null;
        continue;
      }
      if (
        ASSIGNED_CONTEXT_FLAG_REGEX.test(argument) ||
        COMPACT_CONTEXT_FLAG_REGEX.test(argument) ||
        GREP_INLINE_FLAGS_REGEX.test(argument) ||
        GREP_LONG_FLAGS.has(argument)
      ) {
        continue;
      }
      return null;
    }
    if (pattern === null) pattern = unquote(argument);
    else if (filePath === null) filePath = unquote(argument);
    else return null;
  }
  if (pattern === null || filePath === null || filePath === "-") return null;
  if (GLOB_SYNTAX_REGEX.test(filePath)) return null;
  return { filePath, onlyOnSuccess: true };
}

function parseRipgrep(tokens: string[]): InlineReadPlan | null {
  if (tokens[0] !== "rg") return null;
  let pattern: string | null = null;
  let filePath: string | null = null;
  for (let index = 1; index < tokens.length; index++) {
    const argument = tokens[index] ?? "";
    if (argument.startsWith("-") && argument !== "-") {
      if (argument === "-A" || argument === "-B" || argument === "-C") {
        const contextValue = tokens[++index];
        if (contextValue === undefined || !UNSIGNED_INTEGER_REGEX.test(contextValue)) return null;
        continue;
      }
      if (
        argument === "--after-context" ||
        argument === "--before-context" ||
        argument === "--context"
      ) {
        const contextValue = tokens[++index];
        if (contextValue === undefined || !UNSIGNED_INTEGER_REGEX.test(contextValue)) return null;
        continue;
      }
      if (
        ASSIGNED_CONTEXT_FLAG_REGEX.test(argument) ||
        COMPACT_CONTEXT_FLAG_REGEX.test(argument) ||
        RIPGREP_INLINE_FLAGS_REGEX.test(argument) ||
        RIPGREP_LONG_FLAGS.has(argument)
      ) {
        continue;
      }
      return null;
    }
    if (pattern === null) pattern = unquote(argument);
    else if (filePath === null) filePath = unquote(argument);
    else return null;
  }
  if (pattern === null || filePath === null || filePath === "-") return null;
  if (GLOB_SYNTAX_REGEX.test(filePath)) return null;
  return { filePath, onlyOnSuccess: true };
}

function parseLineLimitFlag(
  tokens: string[],
  defaultCount: number,
): readonly [number, string] | null {
  let requestedLines = defaultCount;
  let candidatePath: string | null = null;

  for (let index = 1; index < tokens.length; index++) {
    const argument = tokens[index] ?? "";
    if (argument === "-n" || argument === "--lines") {
      const countArgument = tokens[++index];
      if (countArgument === undefined || !UNSIGNED_INTEGER_REGEX.test(countArgument)) return null;
      requestedLines = Number(countArgument);
      continue;
    }
    const attachedCount = attachedLineCount(argument);
    if (attachedCount !== null) {
      if (!UNSIGNED_INTEGER_REGEX.test(attachedCount)) return null;
      requestedLines = Number(attachedCount);
      continue;
    }
    if (argument.startsWith("-")) return null;
    if (candidatePath !== null) return null;
    candidatePath = unquote(argument);
  }

  if (candidatePath === null || candidatePath === "-" || requestedLines === 0) return null;
  return [requestedLines, candidatePath];
}

function attachedLineCount(argument: string): string | null {
  if (argument.startsWith("--lines=")) return argument.slice("--lines=".length);
  const compactValue = /^-n?(\d+)$/.exec(argument);
  return compactValue?.[1] ?? null;
}

function parseHead(tokens: string[]): InlineReadPlan | null {
  if (tokens[0] !== "head") return null;
  const lineLimit = parseLineLimitFlag(tokens, HEAD_LINE_DEFAULT);
  if (lineLimit === null) return null;
  const [requestedLines, filePath] = lineLimit;
  return {
    filePath,
    selection: { kind: "range", firstLine: 1, lastLine: requestedLines },
  };
}

function parseTail(tokens: string[]): InlineReadPlan | null {
  if (tokens[0] !== "tail") return null;
  const lineLimit = parseLineLimitFlag(tokens, TAIL_LINE_DEFAULT);
  if (lineLimit === null) return null;
  const [requestedLines, filePath] = lineLimit;
  return { filePath, selection: { kind: "tail", count: requestedLines } };
}

export async function loadInlineRead(
  path: string,
  plan: InlineReadPlan,
  signal: AbortSignal | undefined,
): Promise<LoadedInlineRead | null> {
  try {
    const fileInfo = await stat(path);
    if (fileInfo.size > INLINE_READ_SIZE_CEILING || signal?.aborted === true) return null;
    const content = await readFile(path, { encoding: "utf8" });
    if (plan.selection?.kind === "tail") {
      return selectTrailingLines(content, plan.selection.count);
    }
    if (plan.selection?.kind === "range") {
      return selectLineRange(content, plan.selection.firstLine, plan.selection.lastLine);
    }
    return { content };
  } catch {
    return null;
  }
}

function selectTrailingLines(content: string, requestedLines: number): LoadedInlineRead | null {
  const rows = content.split("\n");
  if (rows.at(-1) === "") rows.pop();
  if (rows.length === 0) return null;
  const limit = Math.min(requestedLines, rows.length);
  const firstIndex = rows.length - limit;
  return {
    content: rows.slice(firstIndex).join("\n"),
    offset: firstIndex + 1,
    limit,
  };
}

function selectLineRange(
  content: string,
  requestedStart: number,
  requestedEnd: number | undefined,
): LoadedInlineRead | null {
  const rows = content.split("\n");
  const offset = Math.max(1, requestedStart);
  if (offset > rows.length) return null;
  const endIndex = Math.max(offset, requestedEnd ?? offset);
  const selectedContent = rows.slice(offset - 1, endIndex).join("\n");
  return { content: selectedContent, offset, limit: endIndex - offset + 1 };
}
