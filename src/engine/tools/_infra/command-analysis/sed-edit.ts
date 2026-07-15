import { basename } from "node:path/posix";
import { createPatch } from "diff";
import { tokenizeSegment, unquote } from "@/engine/tools/_infra/command-analysis/shell-tokens.ts";

const SED_PREFIX = /^\s*sed\s+/;
const SUBSTITUTION_PREFIX = "s/";
const DELIMITER = "/";
const ESCAPE = "\\";
const VALID_SUBSTITUTION_FLAGS = /^[gpimIM1-9]*$/;
const DIFF_CONTEXT_LINES = 3;
const IN_PLACE_SHORT = "-i";
const IN_PLACE_LONG = "--in-place";
const BACKUP_SUFFIX_PREFIX = ".";
const EXTENDED_SHORT = "-E";
const EXTENDED_SHORT_ALT = "-r";
const EXTENDED_LONG = "--regexp-extended";
const EXPRESSION_SHORT = "-e";
const EXPRESSION_LONG = "--expression";
const EXPRESSION_LONG_PREFIX = "--expression=";
const FLAG_PREFIX = "-";
const NEXT_OFFSET = 1;
const PAIR_OFFSET = 2;

export interface SedEditInfo {
  filePath: string;
  pattern: string;
  replacement: string;
  flags: string;
  extendedRegex: boolean;
}

export interface SedEditDiff {
  file_path: string;
  diff: string;
}

type SubstitutionState = "pattern" | "replacement" | "flags";

interface SubstitutionParts {
  pattern: string;
  replacement: string;
  flags: string;
}

function isEmptyOrBackupSuffix(token: string | undefined): boolean {
  if (token === undefined) return false;
  return token.length === 0 || token.startsWith(BACKUP_SUFFIX_PREFIX);
}

function parseSubstitutionExpression(expression: string): SubstitutionParts | null {
  if (!expression.startsWith(SUBSTITUTION_PREFIX)) return null;
  const body = expression.slice(SUBSTITUTION_PREFIX.length);
  let pattern = "";
  let replacement = "";
  let flags = "";
  let state: SubstitutionState = "pattern";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] ?? "";
    if (ch === ESCAPE && i + NEXT_OFFSET < body.length) {
      const escaped = ch + (body[i + NEXT_OFFSET] ?? "");
      if (state === "pattern") pattern += escaped;
      else if (state === "replacement") replacement += escaped;
      else flags += escaped;
      i += NEXT_OFFSET;
      continue;
    }
    if (ch === DELIMITER) {
      if (state === "pattern") {
        state = "replacement";
        continue;
      }
      if (state === "replacement") {
        state = "flags";
        continue;
      }
      flags += ch;
      continue;
    }
    if (state === "pattern") pattern += ch;
    else if (state === "replacement") replacement += ch;
    else flags += ch;
  }
  if (state !== "flags") return null;
  if (!VALID_SUBSTITUTION_FLAGS.test(flags)) return null;
  return { pattern, replacement, flags };
}

export function parseSedEditCommand(command: string): SedEditInfo | null {
  const trimmed = command.trim();
  const sedMatch = trimmed.match(SED_PREFIX);
  if (sedMatch === null) return null;

  const tokens = tokenizeSegment(trimmed.slice(sedMatch[0].length)).map(unquote);

  let inPlace = false;
  let extendedRegex = false;
  let expression: string | null = null;
  let filePath: string | null = null;
  let usedExpressionFlag = false;

  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";

    if (token === IN_PLACE_SHORT || token === IN_PLACE_LONG) {
      inPlace = true;
      if (isEmptyOrBackupSuffix(tokens[index + NEXT_OFFSET])) index += PAIR_OFFSET;
      else index += NEXT_OFFSET;
      continue;
    }

    if (token.startsWith(IN_PLACE_SHORT)) {
      inPlace = true;
      index += NEXT_OFFSET;
      continue;
    }

    if (token === EXTENDED_SHORT || token === EXTENDED_SHORT_ALT || token === EXTENDED_LONG) {
      extendedRegex = true;
      index += NEXT_OFFSET;
      continue;
    }

    if (token === EXPRESSION_SHORT || token === EXPRESSION_LONG) {
      if (expression !== null) return null;
      const next = tokens[index + NEXT_OFFSET];
      if (next === undefined) return null;
      expression = next;
      usedExpressionFlag = true;
      index += PAIR_OFFSET;
      continue;
    }

    if (token.startsWith(EXPRESSION_LONG_PREFIX)) {
      if (expression !== null) return null;
      expression = token.slice(EXPRESSION_LONG_PREFIX.length);
      usedExpressionFlag = true;
      index += NEXT_OFFSET;
      continue;
    }

    if (token.startsWith(FLAG_PREFIX)) return null;

    if (expression === null) expression = token;
    else if (filePath === null) filePath = token;
    else return null;
    index += NEXT_OFFSET;
  }

  if (!inPlace || expression === null || filePath === null) return null;

  const parts = parseSubstitutionExpression(expression);
  if (parts === null) return null;

  return {
    filePath,
    pattern: parts.pattern,
    replacement: parts.replacement,
    flags: parts.flags,
    extendedRegex,
  };
}

export function buildSedEditDiff(params: {
  filePath: string;
  before: string;
  after: string;
}): SedEditDiff | null {
  if (params.before === params.after) return null;
  const diff = createPatch(basename(params.filePath), params.before, params.after, "", "", {
    context: DIFF_CONTEXT_LINES,
  });
  return { file_path: params.filePath, diff };
}
