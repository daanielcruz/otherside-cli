import { bashCommand } from "@/kernel/std/proc/shell.ts";
import { truncateBytesAnnotated } from "@/kernel/std/text/text.ts";

const BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g;
const INLINE_PATTERN = /(?<=^|\s)!`([^`]+)`/gm;

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 65_536;

export interface ShellPrefixOptions {
  cwd?: string;
  timeoutMs?: number;
}

export async function expandShellPrefix(
  text: string,
  options: ShellPrefixOptions = {},
): Promise<string> {
  const blockMatches = [...text.matchAll(BLOCK_PATTERN)];
  const inlineMatches = text.includes("!`") ? [...text.matchAll(INLINE_PATTERN)] : [];
  if (blockMatches.length === 0 && inlineMatches.length === 0) return text;

  const replacements = await Promise.all(
    [...blockMatches, ...inlineMatches].map(async (match) => {
      const command = match[1]?.trim();
      if (!command) return { match: match[0], output: "" };
      const output = await runCommand(command, options);
      return { match: match[0], output };
    }),
  );

  let out = text;
  for (const { match, output } of replacements) {
    // Function replacer: command output is inserted verbatim, so `$&`/`$1`/`$$`
    // in it are never interpreted as String.replace substitution patterns.
    out = out.replace(match, () => output);
  }
  return out;
}

async function runCommand(command: string, options: ShellPrefixOptions): Promise<string> {
  const timeout = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  try {
    const proc = Bun.spawn(bashCommand(command), {
      cwd: options.cwd ?? process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const timeoutId = setTimeout(() => proc.kill(), timeout);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    clearTimeout(timeoutId);
    return truncateBytesAnnotated(stdout || stderr, MAX_OUTPUT_BYTES);
  } catch (err) {
    return `(shell-prefix error: ${err instanceof Error ? err.message : String(err)})`;
  }
}
