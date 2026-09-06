const CONTROL_OPERATORS = new Set(["&&", "||", "|", ";"]);
const REDIRECT_OPERATORS = new Set([">", ">>", ">&", "2>", "2>>", "&>", "&>>", "<"]);

const SHELL_OPERATORS = ["2>>", "&>>", "&&", "||", ">>", ">&", "2>", "&>", "|", ";", ">", "<"];

function matchOperatorAt(command: string, index: number): string | null {
  for (const operator of SHELL_OPERATORS) {
    if (command.startsWith(operator, index)) return operator;
  }
  return null;
}

const SILENT_COMMANDS = new Set([
  "mv",
  "cp",
  "rm",
  "mkdir",
  "rmdir",
  "chmod",
  "chown",
  "chgrp",
  "touch",
  "ln",
  "cd",
  "export",
  "unset",
  "wait",
]);

const SEMANTIC_NEUTRAL_COMMANDS = new Set(["echo", "printf", "true", "false", ":"]);

export interface SplitToken {
  kind: "part" | "operator";
  text: string;
}

export function splitCommandOnOperators(command: string): SplitToken[] {
  const tokens: SplitToken[] = [];
  let current = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  while (i < command.length) {
    const ch = command[i] ?? "";
    if (ch === "\\" && !inSingle) {
      current += ch + (command[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (ch === "'" && !inDouble && !inBacktick) {
      inSingle = !inSingle;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && !inSingle && !inBacktick) {
      inDouble = !inDouble;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "`" && !inSingle) {
      inBacktick = !inBacktick;
      current += ch;
      i += 1;
      continue;
    }
    if (!inSingle && !inDouble && !inBacktick) {
      const operator = matchOperatorAt(command, i);
      if (operator) {
        flushPart(tokens, current);
        current = "";
        tokens.push({ kind: "operator", text: operator });
        i += operator.length;
        continue;
      }
    }
    current += ch;
    i += 1;
  }
  flushPart(tokens, current);
  return tokens;
}

function flushPart(tokens: SplitToken[], buffer: string): void {
  const trimmed = buffer.trim();
  if (trimmed.length > 0) tokens.push({ kind: "part", text: trimmed });
}

export function splitCommandParts(command: string): string[] {
  const tokens = splitCommandOnOperators(command);
  const parts: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    if (tok.kind === "operator") {
      if (REDIRECT_OPERATORS.has(tok.text)) {
        i++;
      }
      continue;
    }
    const next = tokens[i + 1];
    if (next && next.kind === "operator" && REDIRECT_OPERATORS.has(next.text)) {
      if (/^\d+$/.test(tok.text.trim())) {
        continue;
      }
      const trimmed = tok.text.trimEnd();
      if (/\s\d$/.test(trimmed)) {
        parts.push(trimmed.slice(0, -2));
        continue;
      }
    }
    parts.push(tok.text);
  }
  return parts;
}

export function extractBaseCommand(part: string): string {
  const trimmed = part.trim();
  if (trimmed.length === 0) return "";
  return trimmed.split(/\s+/)[0] ?? "";
}

export function bashCommentLabel(command: string): string | undefined {
  const nl = command.indexOf("\n");
  const firstLine = (nl === -1 ? command : command.slice(0, nl)).trim();
  if (!firstLine.startsWith("#") || firstLine.startsWith("#!")) return undefined;
  const stripped = firstLine.replace(/^#+\s*/, "");
  return stripped.length > 0 ? stripped : undefined;
}

export function isSilentCommand(command: string): boolean {
  let tokens: SplitToken[];
  try {
    tokens = splitCommandOnOperators(command);
  } catch {
    return false;
  }
  if (tokens.length === 0) return false;
  let hasNonFallbackCommand = false;
  let lastOperator: string | null = null;
  let skipNextAsRedirectTarget = false;
  for (const tok of tokens) {
    if (skipNextAsRedirectTarget) {
      skipNextAsRedirectTarget = false;
      continue;
    }
    if (tok.kind === "operator") {
      if (REDIRECT_OPERATORS.has(tok.text)) {
        skipNextAsRedirectTarget = true;
        continue;
      }
      if (CONTROL_OPERATORS.has(tok.text)) {
        lastOperator = tok.text;
        continue;
      }
      continue;
    }
    const baseCommand = extractBaseCommand(tok.text);
    if (baseCommand.length === 0) continue;
    if (lastOperator === "||" && SEMANTIC_NEUTRAL_COMMANDS.has(baseCommand)) {
      continue;
    }
    hasNonFallbackCommand = true;
    if (!SILENT_COMMANDS.has(baseCommand)) return false;
  }
  return hasNonFallbackCommand;
}

export interface InterpretedResult {
  isError: boolean;
  message?: string;
}

type CommandSemantic = (exitCode: number) => InterpretedResult;

const COMMAND_SEMANTICS: Map<string, CommandSemantic> = new Map([
  [
    "grep",
    (exitCode): InterpretedResult => ({
      isError: exitCode >= 2,
      ...(exitCode === 1 ? { message: "No matches found" } : {}),
    }),
  ],
  [
    "egrep",
    (exitCode): InterpretedResult => ({
      isError: exitCode >= 2,
      ...(exitCode === 1 ? { message: "No matches found" } : {}),
    }),
  ],
  [
    "fgrep",
    (exitCode): InterpretedResult => ({
      isError: exitCode >= 2,
      ...(exitCode === 1 ? { message: "No matches found" } : {}),
    }),
  ],
  [
    "rg",
    (exitCode): InterpretedResult => ({
      isError: exitCode >= 2,
      ...(exitCode === 1 ? { message: "No matches found" } : {}),
    }),
  ],
  [
    "find",
    (exitCode): InterpretedResult => ({
      isError: exitCode >= 2,
      ...(exitCode === 1 ? { message: "Some directories were inaccessible" } : {}),
    }),
  ],
  [
    "diff",
    (exitCode): InterpretedResult => ({
      isError: exitCode >= 2,
      ...(exitCode === 1 ? { message: "Files differ" } : {}),
    }),
  ],
  [
    "test",
    (exitCode): InterpretedResult => ({
      isError: exitCode >= 2,
      ...(exitCode === 1 ? { message: "Condition is false" } : {}),
    }),
  ],
  [
    "[",
    (exitCode): InterpretedResult => ({
      isError: exitCode >= 2,
      ...(exitCode === 1 ? { message: "Condition is false" } : {}),
    }),
  ],
]);

const DEFAULT_SEMANTIC: CommandSemantic = (exitCode): InterpretedResult => ({
  isError: exitCode !== 0,
  ...(exitCode !== 0 ? { message: `Command failed with exit code ${exitCode}` } : {}),
});

function heuristicallyExtractLastBaseCommand(command: string): string {
  const segments = splitCommandParts(command);
  const lastCommand = segments[segments.length - 1] ?? command;
  return extractBaseCommand(lastCommand);
}

function parseGitSubcommand(command: string): string | undefined {
  const parts = splitCommandParts(command);
  const last = parts[parts.length - 1];
  if (!last) return undefined;
  const tokens = last.trim().split(/\s+/);
  if (tokens[0] !== "git") return undefined;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (token.startsWith("-")) {
      if (token === "-C" || token === "-c") i++;
      continue;
    }
    return token;
  }
  return undefined;
}

export function classifyCommandOutcome(command: string, exitCode: number): InterpretedResult {
  const base = heuristicallyExtractLastBaseCommand(command);
  if (base === "git") {
    const subcommand = parseGitSubcommand(command);
    if (subcommand === "diff" || subcommand === "grep") {
      return {
        isError: exitCode >= 2,
        ...(exitCode === 1
          ? { message: subcommand === "grep" ? "No matches found" : "Files differ" }
          : {}),
      };
    }
  }
  const semantic = COMMAND_SEMANTICS.get(base) ?? DEFAULT_SEMANTIC;
  return semantic(exitCode);
}
