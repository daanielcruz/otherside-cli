import { unquote } from "./shell-tokens.ts";

// Read-only sed classifier — accepts exactly two provably-safe shapes:
//   1. print-only:            sed -n '1,20p' file    (-n required; only p / Np / N,Mp)
//   2. substitution to stdout: sed 's/old/new/g'     (single s///, no file args, no -i)
// Everything else (w/W/e/E commands, -i, blocks, GNU step/offset addresses,
// alternate delimiters, y-command tricks) FAILS CLOSED to the permission prompt.
// A script allowlist alone is not enough — a matching shape is still re-screened
// by the expression denylist below (defense in depth).

const PRINT_FLAGS: ReadonlySet<string> = new Set([
  "-n",
  "--quiet",
  "--silent",
  "-E",
  "--regexp-extended",
  "-r",
  "-z",
  "--zero-terminated",
  "--posix",
]);

const SUBSTITUTION_FLAGS: ReadonlySet<string> = new Set([
  "-E",
  "--regexp-extended",
  "-r",
  "--posix",
]);

// `p`, `12p`, `3,40p` — nothing else prints without side effects.
const PRINT_COMMAND_RE = /^(?:\d+|\d+,\d+)?p$/;

function allFlagsAllowed(flags: readonly string[], allowed: ReadonlySet<string>): boolean {
  return flags.every((flag) => {
    // a bundled short group (-nE) is safe only if every character is
    if (!flag.startsWith("--") && flag.length > 2) {
      return [...flag.slice(1)].every((ch) => allowed.has(`-${ch}`));
    }
    return allowed.has(flag);
  });
}

function hasQuietFlag(flags: readonly string[]): boolean {
  return flags.some(
    (flag) =>
      flag === "--quiet" ||
      flag === "--silent" ||
      (!flag.startsWith("--") && flag.startsWith("-") && flag.includes("n")),
  );
}

interface SedInvocation {
  flags: string[];
  expressions: string[];
  hasFileArgs: boolean;
}

function parseSedInvocation(args: readonly string[]): SedInvocation | null {
  const flags: string[] = [];
  const expressions: string[] = [];
  let sawExpressionOption = false;
  let sawBareExpression = false;
  let hasFileArgs = false;
  for (let i = 0; i < args.length; i++) {
    const token = unquote(args[i] ?? "");
    if (token === "-e" || token === "--expression") {
      const next = args[i + 1];
      if (next === undefined) return null;
      sawExpressionOption = true;
      expressions.push(unquote(next));
      i++;
      continue;
    }
    if (token.startsWith("--expression=")) {
      sawExpressionOption = true;
      expressions.push(token.slice("--expression=".length));
      continue;
    }
    if (token.startsWith("-e=")) {
      sawExpressionOption = true;
      expressions.push(token.slice("-e=".length));
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      flags.push(token);
      continue;
    }
    // with -e in play every positional is a file; otherwise the first
    // positional is the script and the rest are files
    if (sawExpressionOption || sawBareExpression) {
      hasFileArgs = true;
      continue;
    }
    expressions.push(token);
    sawBareExpression = true;
  }
  return { flags, expressions, hasFileArgs };
}

function isPrintOnlyInvocation(invocation: SedInvocation): boolean {
  if (!allFlagsAllowed(invocation.flags, PRINT_FLAGS)) return false;
  if (!hasQuietFlag(invocation.flags)) return false;
  if (invocation.expressions.length === 0) return false;
  return invocation.expressions.every((expression) =>
    expression.split(";").every((command) => PRINT_COMMAND_RE.test(command.trim())),
  );
}

function isStdoutSubstitutionInvocation(invocation: SedInvocation): boolean {
  if (invocation.hasFileArgs) return false;
  if (!allFlagsAllowed(invocation.flags, SUBSTITUTION_FLAGS)) return false;
  if (invocation.expressions.length !== 1) return false;
  const expression = (invocation.expressions[0] ?? "").trim();
  if (expression.includes(";")) return false;
  // strict shape: `s/` delimiter only, exactly two more unescaped delimiters
  if (!expression.startsWith("s/")) return false;
  const rest = expression.slice(2);
  let delimiterCount = 0;
  let lastDelimiterAt = -1;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "\\") {
      i++;
      continue;
    }
    if (rest[i] === "/") {
      delimiterCount++;
      lastDelimiterAt = i;
    }
  }
  if (delimiterCount !== 2) return false;
  const substitutionFlags = rest.slice(lastDelimiterAt + 1);
  return /^[gpimIM]*[1-9]?[gpimIM]*$/.test(substitutionFlags);
}

// Expression denylist — rejects every context where w/W (write file) or e/E
// (execute) could act as a sed command or s///-flag, plus the constructs too
// ambiguous to prove safe (blocks, negation, GNU addresses, homoglyphs,
// alternate delimiters). When in doubt, dangerous.
function sedExpressionIsDangerous(expression: string): boolean {
  const command = expression.trim();
  if (!command) return false;
  // non-ASCII — Unicode homoglyphs of w/e, combining chars
  if (/[^\x01-\x7F]/.test(command)) return true;
  // blocks and multi-line scripts are too complex to prove safe
  if (command.includes("{") || command.includes("}")) return true;
  if (command.includes("\n")) return true;
  // `#` is a comment unless it directly follows `s` as a delimiter
  const hashAt = command.indexOf("#");
  if (hashAt !== -1 && !(hashAt > 0 && command[hashAt - 1] === "s")) return true;
  // negation operator (leading `!` or after an address)
  if (/^!/.test(command) || /[/\d$]!/.test(command)) return true;
  // GNU step addresses (first~step)
  if (/\d\s*~\s*\d|,\s*~\s*\d|\$\s*~\s*\d/.test(command)) return true;
  // bare leading comma (1,$ shorthand) and GNU offset addresses (,+N)
  if (/^,/.test(command)) return true;
  if (/,\s*[+-]/.test(command)) return true;
  // backslash delimiter tricks: `s\…` or `\|`-style alternate delimiters
  if (/s\\/.test(command) || /\\[|#%@]/.test(command)) return true;
  // escaped-slash paths flowing into w/W (/\/path\/file/w)
  if (/\\\/.*[wW]/.test(command)) return true;
  // pattern followed by whitespace then a w/W/e/E command
  if (/\/[^/]*\s+[wWeE]/.test(command)) return true;
  // malformed s/ commands that don't have exactly three clean fields
  if (/^s\//.test(command) && !/^s\/[^/]*\/[^/]*\/[^/]*$/.test(command)) return true;
  // any s-command ending in w/W/e/E that isn't a well-formed substitution
  if (/^s./.test(command) && /[wWeE]$/.test(command)) {
    const wellFormed = /^s([^\\\n]).*?\1.*?\1[^wWeE]*$/.test(command);
    if (!wellFormed) return true;
  }
  // w/W as a command after any address form
  if (
    /^[wW]\s*\S+/.test(command) ||
    /^\d+\s*[wW]\s*\S+/.test(command) ||
    /^\$\s*[wW]\s*\S+/.test(command) ||
    /^\/[^/]*\/[IMim]*\s*[wW]\s*\S+/.test(command) ||
    /^\d+,\d+\s*[wW]\s*\S+/.test(command) ||
    /^\d+,\$\s*[wW]\s*\S+/.test(command) ||
    /^\/[^/]*\/[IMim]*,\/[^/]*\/[IMim]*\s*[wW]\s*\S+/.test(command)
  ) {
    return true;
  }
  // e as a command after any address form
  if (
    /^e/.test(command) ||
    /^\d+\s*e/.test(command) ||
    /^\$\s*e/.test(command) ||
    /^\/[^/]*\/[IMim]*\s*e/.test(command) ||
    /^\d+,\d+\s*e/.test(command) ||
    /^\d+,\$\s*e/.test(command) ||
    /^\/[^/]*\/[IMim]*,\/[^/]*\/[IMim]*\s*e/.test(command)
  ) {
    return true;
  }
  // s<any-delim>…<delim>…<delim>flags carrying a w/W/e/E flag
  const substitution = command.match(/s([^\\\n]).*?\1.*?\1(.*?)$/);
  if (substitution && /[wWeE]/.test(substitution[2] ?? "")) return true;
  // y (transliterate) followed by any w/W/e/E anywhere is suspicious
  if (/y([^\\\n])/.test(command) && /[wWeE]/.test(command)) return true;
  return false;
}

export function isReadOnlySedInvocation(args: readonly string[]): boolean {
  // glued dangerous option pairs (-ew file, -we …) — refuse before parsing
  const hasGluedDangerousOption = args.some((raw) => {
    const token = unquote(raw);
    return /-e[wWe]/.test(token) || /-w[eE]/.test(token);
  });
  if (hasGluedDangerousOption) return false;
  const invocation = parseSedInvocation(args);
  if (!invocation) return false;
  if (!isPrintOnlyInvocation(invocation) && !isStdoutSubstitutionInvocation(invocation)) {
    return false;
  }
  return !invocation.expressions.some(sedExpressionIsDangerous);
}
