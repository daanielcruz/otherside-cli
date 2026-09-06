import { splitCommandParts } from "@/engine/tools/_infra/command-analysis/commands.ts";

const BINARY_HIJACK_VARS = new Set([
  "PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "DYLD_FALLBACK_FRAMEWORK_PATH",
  "NODE_OPTIONS",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYOPT",
  "GIT_EXEC_PATH",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "BASHOPTS",
]);

const SAFE_WRAPPERS = new Set([
  "timeout",
  "nohup",
  "nice",
  "ionice",
  "stdbuf",
  "unbuffer",
  "time",
  "command",
  "exec",
  "env",
]);

const SAFE_WRAPPER_FLAG_VALUE = new Set([
  "-n",
  "-v",
  "-V",
  "-c",
  "-p",
  "-f",
  "-s",
  "-k",
  "-u",
  "--preserve-status",
  "--foreground",
  "--kill-after",
  "--signal",
]);

const SAFE_WRAPPER_FLAG_NO_VALUE = new Set(["-N", "-l", "-L", "--version", "--help"]);

const SAFE_WRAPPERS_WITH_LEADING_POSITIONAL = new Set(["timeout"]);

const ENV_VAR_ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=/;

export type ExcludedRule =
  | { type: "exact"; command: string }
  | { type: "prefix"; prefix: string }
  | { type: "wildcard"; pattern: string };

export function parseExcludedRule(pattern: string): ExcludedRule {
  const trimmed = pattern.trim();
  if (trimmed.endsWith(":*")) {
    return { type: "prefix", prefix: trimmed.slice(0, -2).trim() };
  }
  if (trimmed.includes("*") || trimmed.includes("?")) {
    return { type: "wildcard", pattern: trimmed };
  }
  return { type: "exact", command: trimmed };
}

function matchesRule(rule: ExcludedRule, candidate: string): boolean {
  switch (rule.type) {
    case "exact":
      return candidate === rule.command;
    case "prefix":
      return candidate === rule.prefix || candidate.startsWith(`${rule.prefix} `);
    case "wildcard": {
      const regex = new RegExp(
        `^${rule.pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\?/g, ".")
          .replace(/\*/g, ".*")}$`,
      );
      return regex.test(candidate);
    }
  }
}

export function stripLeadingEnvAssignments(command: string): string {
  let cur = command.trim();
  while (true) {
    const match = cur.match(ENV_VAR_ASSIGN_RE);
    if (!match) break;
    const varName = match[1] ?? "";
    if (!BINARY_HIJACK_VARS.has(varName)) {
      const space = cur.indexOf(" ");
      if (space === -1) break;
      cur = cur.slice(space + 1).trim();
      continue;
    }
    const space = cur.indexOf(" ");
    if (space === -1) return "";
    cur = cur.slice(space + 1).trim();
  }
  return cur;
}

export function stripSafeWrappers(command: string): string {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length === 0) return command;
  const head = tokens[0] ?? "";
  if (!SAFE_WRAPPERS.has(head)) return command;
  let i = 1;
  while (i < tokens.length) {
    const tok = tokens[i] ?? "";
    if (SAFE_WRAPPER_FLAG_VALUE.has(tok)) {
      i += 2;
      continue;
    }
    if (SAFE_WRAPPER_FLAG_NO_VALUE.has(tok)) {
      i += 1;
      continue;
    }
    if (tok.startsWith("-")) {
      i += 1;
      continue;
    }
    if (ENV_VAR_ASSIGN_RE.test(tok)) {
      i += 1;
      continue;
    }
    break;
  }
  if (SAFE_WRAPPERS_WITH_LEADING_POSITIONAL.has(head) && i < tokens.length) {
    i += 1;
  }
  return tokens.slice(i).join(" ").trim();
}

export function hasExcludedSubcommand(command: string, excludedPatterns: string[]): boolean {
  if (excludedPatterns.length === 0) return false;
  const rules = excludedPatterns.map(parseExcludedRule);
  let subcommands: string[];
  try {
    subcommands = splitCommandParts(command);
  } catch {
    subcommands = [command];
  }
  if (subcommands.length === 0) subcommands = [command];
  for (const sub of subcommands) {
    if (matchesAnyRule(sub.trim(), rules)) return true;
  }
  return false;
}

function matchesAnyRule(sub: string, rules: ExcludedRule[]): boolean {
  const candidates: string[] = [sub];
  const seen = new Set(candidates);
  let cursor = 0;
  while (cursor < candidates.length) {
    const end = candidates.length;
    for (let i = cursor; i < end; i++) {
      const cmd = candidates[i] ?? "";
      const envStripped = stripLeadingEnvAssignments(cmd);
      if (envStripped.length > 0 && !seen.has(envStripped)) {
        candidates.push(envStripped);
        seen.add(envStripped);
      }
      const wrapperStripped = stripSafeWrappers(cmd);
      if (wrapperStripped.length > 0 && !seen.has(wrapperStripped)) {
        candidates.push(wrapperStripped);
        seen.add(wrapperStripped);
      }
    }
    cursor = end;
  }
  for (const cand of candidates) {
    for (const rule of rules) {
      if (matchesRule(rule, cand)) return true;
    }
  }
  return false;
}
