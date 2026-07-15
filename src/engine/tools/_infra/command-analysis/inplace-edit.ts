import { isAbsolute, resolve } from "node:path/posix";
import {
  isQuoted,
  tokenizeSegment,
  unquote,
} from "@/engine/tools/_infra/command-analysis/shell-tokens.ts";

const SEGMENT_SPLIT = /\s*(?:&&|\|\||;|\|)\s*/;
const LEADING_ENV = /^[A-Z_][A-Z0-9_]*=\S*$/;

const TARGETS = [
  { bin: /^g?sed$/, inplaceFlag: /^-i(?:[.A-Za-z0-9_-]+|'')?$|^--in-place(?:=.+)?$/ },
  { bin: /^g?awk$/, inplaceFlag: /^-i$/, requireInplaceArg: true },
  { bin: /^perl$/, inplaceFlag: /^-i(?:[.A-Za-z0-9_-]+)?$/ },
];

function stripLeadingEnvAndWrappers(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && tokens[i] && LEADING_ENV.test(tokens[i]!)) i++;
  while (i < tokens.length) {
    const t = tokens[i] ?? "";
    if (t === "timeout" || t === "nice" || t === "nohup") {
      if (tokens[i + 1] && /^\d/.test(tokens[i + 1]!)) i += 2;
      else i += 1;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

function looksLikePath(token: string): boolean {
  if (token.length === 0) return false;
  if (token.startsWith("-")) return false;
  if (token.includes("=")) return false;
  return true;
}

function extractTargetsForSegment(segment: string): string[] {
  const raw = tokenizeSegment(segment);
  if (raw.length === 0) return [];
  const tokens = stripLeadingEnvAndWrappers(raw);
  if (tokens.length === 0) return [];
  const bin = tokens[0]?.replace(/.*\//, "") ?? "";
  if (!bin) return [];
  const target = TARGETS.find((t) => t.bin.test(bin));
  if (!target) return [];
  const isSed = /^g?sed$/.test(bin);
  let cursor = 1;
  let inplace = false;
  while (cursor < tokens.length) {
    const tok = tokens[cursor] ?? "";
    if (!tok.startsWith("-")) break;
    if (target.inplaceFlag.test(tok)) {
      inplace = true;
      cursor += 1;
      if (target.requireInplaceArg) {
        if (tokens[cursor] === "inplace") {
          cursor += 1;
        } else {
          inplace = false;
        }
      } else if (isSed && tok === "-i") {
        const next = tokens[cursor];
        if (next === "''" || next === '""') cursor += 1;
      }
      continue;
    }
    if (tok === "-e" || tok === "-f" || tok === "-E" || tok === "--expression") {
      cursor += 2;
      continue;
    }
    cursor += 1;
  }
  if (!inplace) return [];
  while (cursor < tokens.length) {
    const tok = tokens[cursor] ?? "";
    if (isQuoted(tok) && bin !== "perl") {
      cursor += 1;
      break;
    }
    if (bin === "perl" && isQuoted(tok)) {
      cursor += 1;
      continue;
    }
    if (!tok.startsWith("-")) break;
    cursor += 1;
  }
  const files: string[] = [];
  for (; cursor < tokens.length; cursor++) {
    const tok = tokens[cursor] ?? "";
    if (!looksLikePath(tok)) continue;
    files.push(unquote(tok));
  }
  return files;
}

export function detectInplaceEditTargets(command: string, cwd: string): string[] {
  const segments = command.split(SEGMENT_SPLIT);
  const out = new Set<string>();
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (trimmed.length === 0) continue;
    const targets = extractTargetsForSegment(trimmed);
    for (const t of targets) {
      const abs = isAbsolute(t) ? t : resolve(cwd, t);
      out.add(abs);
    }
  }
  return Array.from(out);
}
