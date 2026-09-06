export const SAFE_ENV_VARS: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "BLOCK_SIZE",
  "BLOCKSIZE",
  "CGO_ENABLED",
  "CHARSET",
  "CI",
  "CLICOLOR",
  "CLICOLOR_FORCE",
  "COLORTERM",
  "COLUMNS",
  "DEBIAN_FRONTEND",
  "FORCE_COLOR",
  "GCC_COLORS",
  "GIT_TERMINAL_PROMPT",
  "GO111MODULE",
  "GOARCH",
  "GOEXPERIMENT",
  "GOOS",
  "GREP_COLOR",
  "GREP_COLORS",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_TIME",
  "LINES",
  "LSCOLORS",
  "LS_COLORS",
  "NODE_ENV",
  "NO_COLOR",
  "PYTEST_DEBUG",
  "PYTEST_DISABLE_PLUGIN_AUTOLOAD",
  "PYTHONDONTWRITEBYTECODE",
  "PYTHONUNBUFFERED",
  "RUST_BACKTRACE",
  "RUST_LOG",
  "TERM",
  "TIME_STYLE",
  "TZ",
]);

export const SAFE_WRAPPERS: ReadonlySet<string> = new Set([
  "timeout",
  "time",
  "nice",
  "nohup",
  "stdbuf",
]);

// Shells that run an arbitrary script string passed via `-c` — the body is a
// single quoted token, invisible to token-level command-head checks unless
// extracted and re-parsed.
export const SHELL_DASH_C_HEADS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "csh",
  "tcsh",
  "ksh",
  "dash",
  "powershell",
  "pwsh",
]);

const DANGEROUS_FIND_FLAGS: ReadonlySet<string> = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

export const MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50;

const ENV_ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=/;

export function stripLeadingSafeEnvVars(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) break;
    const match = ENV_ASSIGNMENT_RE.exec(token);
    if (!match) break;
    const name = match[1];
    if (!name || !SAFE_ENV_VARS.has(name)) break;
    i++;
  }
  return tokens.slice(i);
}

export function stripLeadingEnvAssignments(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token || !ENV_ASSIGNMENT_RE.test(token)) break;
    i++;
  }
  return tokens.slice(i);
}

export function stripSafeWrappers(tokens: string[]): string[] {
  let result = tokens;
  while (result.length > 0) {
    const first = result[0];
    if (!first || !SAFE_WRAPPERS.has(first)) break;
    if (first === "timeout" && result.length > 1) {
      result = result.slice(2);
      continue;
    }
    result = result.slice(1);
  }
  return result;
}

// Exec-wrappers run an arbitrary command after their own options/env: `env
// X=1 find …`, `sudo find …`, `sudo -u root find …`. Each wrapper's options
// that take a separate-token argument must be consumed WITH that argument, or
// the real command head is misread. Anything ambiguous is peeled greedily —
// the caller fails closed (an over-peel that lands off `find` merely drops to a
// prompt), so missing the underlying command is the only unsafe outcome.
const EXEC_WRAPPER_ARG_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["env", new Set(["-u", "-C", "-S", "-P"])],
  ["sudo", new Set(["-u", "-g", "-C", "-p", "-r", "-t", "-U", "-h", "-D", "-R", "-a"])],
  ["doas", new Set(["-a", "-C", "-u"])],
  ["pkexec", new Set(["--user"])],
]);

export function stripExecWrappers(tokens: string[]): string[] {
  const wrapper = tokens[0];
  if (!wrapper) return tokens;
  const argOptions = EXEC_WRAPPER_ARG_OPTIONS.get(wrapper);
  if (!argOptions) return tokens;
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token?.startsWith("-")) break;
    // `--` / `-` end option processing; the rest is the command.
    if (token === "--" || token === "-") {
      i++;
      break;
    }
    // `--user=root` / `-u=root` carry their argument inline — one token only.
    if (argOptions.has(token) && !token.includes("=")) i++;
    i++;
  }
  // `env` may then carry NAME=VALUE assignments before the command.
  return wrapper === "env" ? stripLeadingEnvAssignments(tokens.slice(i)) : tokens.slice(i);
}

export function looksLikeXargsCarrier(tokens: string[]): { remainder: string[] } | null {
  if (tokens[0] !== "xargs") return null;
  const remainder = tokens.slice(1).filter((t) => !t.startsWith("-"));
  if (remainder.length === 0) return null;
  return { remainder };
}

// Whitespace split that keeps a quoted span as one token (quotes removed,
// backslash escapes honored outside single quotes). An unterminated quote
// flushes the remainder as-is — callers only compare token equality, so a
// malformed command simply fails to match `find` and falls back to a prompt.
export function tokenizeRespectingQuotes(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += command[i + 1];
      started = true;
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else current += ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      started = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

// A shell head running a `-c` script (`sh -c "find . -delete"`, `bash -lc …`)
// hides the real command inside one string token — return that body so the
// caller can re-check it as a command of its own.
export function shellDashCBody(tokens: string[]): string | null {
  const head = tokens[0];
  if (!head || !SHELL_DASH_C_HEADS.has(head)) return null;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (!token.startsWith("-")) return null; // positional script file — no -c body
    if (token === "-c" || token === "-Command" || token === "-command") {
      const body = tokens[i + 1] === "--" ? tokens[i + 2] : tokens[i + 1];
      return body ?? null;
    }
    // `bash -o pipefail -c …` consumes `pipefail` as the -o option argument.
    if (token === "-o") {
      i++;
      continue;
    }
    // A quoted command body may be glued to `-c`, e.g. `sh -c'find . -delete'`.
    // Keep existing short-option cluster handling for ambiguous `-ce` forms.
    if (token.startsWith("-c") && /\s/.test(token.slice(2))) return token.slice(2);
    // bundled short options carrying c, e.g. `bash -lc "…"` / `sh -ec "…"`
    if (/^-[A-Za-z]+$/.test(token) && token.includes("c")) return tokens[i + 1] ?? null;
  }
  return null;
}

export function allowRuleCoversDangerousFind(command: string): boolean {
  const tokens = tokenizeRespectingQuotes(command);
  // An env-var assignment, safe wrapper, or exec-wrapper (`DEBUG=1 find …`,
  // `timeout 10 find …`, `env X=1 find …`, `sudo find …`) must not hide the
  // real `find` head. Peel them off to a fixpoint before deciding.
  let stripped = tokens;
  for (;;) {
    const next = stripExecWrappers(stripSafeWrappers(stripLeadingEnvAssignments(stripped)));
    if (next.length === stripped.length) break;
    stripped = next;
  }
  if (stripped[0] !== "find") {
    // The body recursion terminates: each level's body is strictly shorter
    // than its carrier command.
    const body = shellDashCBody(stripped);
    return body !== null && allowRuleCoversDangerousFind(body);
  }
  return stripped.some((t) => {
    if (DANGEROUS_FIND_FLAGS.has(t)) return true;
    for (const dangerous of DANGEROUS_FIND_FLAGS) {
      if (t.startsWith(`${dangerous}=`)) return true;
    }
    return false;
  });
}

export function stripHeredocBody(command: string): string {
  const heredocStart = command.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
  if (!heredocStart || heredocStart.index === undefined) return command;
  const marker = heredocStart[2];
  const headEnd = heredocStart.index + heredocStart[0].length;
  const head = command.slice(0, headEnd);
  const body = command.slice(headEnd);
  const closeRe = new RegExp(`\\n${marker}(?:\\n|$)`);
  const closeMatch = body.match(closeRe);
  if (!closeMatch || closeMatch.index === undefined) return head;
  return head + body.slice(closeMatch.index + closeMatch[0].length);
}

const SAFE_REDIRECT_PATTERNS: readonly RegExp[] = [
  /\s+2\s*>&\s*1(?=\s|$)/g,
  /[012]?\s*>\s*\/dev\/null(?=\s|$)/g,
  /\s*<\s*\/dev\/null(?=\s|$)/g,
];

export function containsUnsafeRedirect(command: string): boolean {
  let stripped = command;
  for (const pattern of SAFE_REDIRECT_PATTERNS) stripped = stripped.replace(pattern, "");
  return /[<>]/.test(stripped);
}

// `&` glued to a redirect (`>&`, `<&`, `&>`) duplicates a file descriptor;
// only a standalone `&` (background operator) separates commands.
export function isFdRedirectAmpersand(command: string, index: number): boolean {
  const prev = command[index - 1];
  return prev === ">" || prev === "<" || command[index + 1] === ">";
}

export function isCompoundForGuard(
  command: string,
  capSubcommands = MAX_SUBCOMMANDS_FOR_SECURITY_CHECK,
): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes("\n")) return true;
  if (/\$\(|`/.test(trimmed)) return true;
  let count = 0;
  let i = 0;
  while (i < trimmed.length && count < capSubcommands) {
    const ch = trimmed[i];
    const next = trimmed[i + 1];
    if (ch === "&" && next === "&") {
      count++;
      i += 2;
      continue;
    }
    if (ch === "&") {
      if (!isFdRedirectAmpersand(trimmed, i)) count++;
      i++;
      continue;
    }
    if (ch === "|" && next === "|") {
      count++;
      i += 2;
      continue;
    }
    if (ch === ";" || ch === "|") {
      count++;
      i++;
      continue;
    }
    i++;
  }
  return count >= 1;
}
