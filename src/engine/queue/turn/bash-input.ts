// `!` bash input mode: prompt-side prefix encoding, local shell execution, and
// the wire shape of the follow-up model turn.
//
// A bash-mode submission travels as `!command` (the prefix is also the storage
// form in prompt history). The dispatch layer runs the command locally, echoes
// it to the transcript, and then runs a FULL model turn whose user message
// carries two text blocks:
//
//   <bash-input>command</bash-input>\n
//   <bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>
//
// stdout/stderr are XML-escaped on the wire; the command itself is not.

import { escapeXml } from "@/engine/background/tasks/notification.ts";
import { shellCommand } from "@/kernel/std/proc/shell.ts";
import { getTrackedCwd } from "@/kernel/std/state/cwd-state.ts";
import { truncateBytesAnnotated } from "@/kernel/std/text/text.ts";
import type { ContentBlock, ToolResultMeta } from "@/kernel/std/types/message.ts";

export const BASH_MODE_PREFIX = "!";

export type PromptInputMode = "prompt" | "bash";

export function promptInputModeOf(text: string): PromptInputMode {
  return text.startsWith(BASH_MODE_PREFIX) ? "bash" : "prompt";
}

// The command body of a bash-mode submission ("!ls -la" → "ls -la").
// Non-bash text passes through unchanged.
export function stripBashPrefix(text: string): string {
  return promptInputModeOf(text) === "bash" ? text.slice(BASH_MODE_PREFIX.length) : text;
}

export function withPromptMode(text: string, mode: PromptInputMode): string {
  return mode === "bash" ? BASH_MODE_PREFIX + text : text;
}

export interface BashInputRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const BASH_INPUT_TIMEOUT_MS = 120_000;
const MAX_BASH_INPUT_OUTPUT_BYTES = 65_536;

// Run a bash-mode command through the user's shell, capturing stdout and
// stderr separately. Never throws: spawn failures come back as stderr so the
// wire turn (and the transcript echo) always have something to carry.
export async function runBashInput(
  command: string,
  opts?: { cwd?: string; timeoutMs?: number },
): Promise<BashInputRun> {
  try {
    const proc = Bun.spawn(shellCommand(command), {
      cwd: opts?.cwd ?? getTrackedCwd(),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const timeoutId = setTimeout(() => proc.kill(), opts?.timeoutMs ?? BASH_INPUT_TIMEOUT_MS);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timeoutId);
    return {
      stdout: truncateBytesAnnotated(stdout, MAX_BASH_INPUT_OUTPUT_BYTES),
      stderr: truncateBytesAnnotated(stderr, MAX_BASH_INPUT_OUTPUT_BYTES),
      exitCode,
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: `Command failed: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
    };
  }
}

// The two user-message text blocks of the follow-up model turn.
export function bashTurnBlocks(command: string, run: BashInputRun): ContentBlock[] {
  return [
    { type: "text", text: `<bash-input>${command}</bash-input>\n` },
    {
      type: "text",
      text: `<bash-stdout>${escapeXml(run.stdout)}</bash-stdout><bash-stderr>${escapeXml(run.stderr)}</bash-stderr>`,
    },
  ];
}

// Flat form of the same turn, used as the persisted user-record content so a
// resumed session can rebuild the transcript echo via parseBashTurnText.
export function bashTurnText(command: string, run: BashInputRun): string {
  return bashTurnBlocks(command, run)
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

export interface BashTurnParts {
  command: string;
  stdout: string;
  stderr: string;
}

function unescapeXml(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

// Recognize a persisted bash-mode user record. Returns null for any other
// user-message content.
export function parseBashTurnText(text: string): BashTurnParts | null {
  const command = text.match(/^<bash-input>([\s\S]*?)<\/bash-input>/)?.[1];
  if (command === undefined) return null;
  const stdout = text.match(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/)?.[1] ?? "";
  const stderr = text.match(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/)?.[1] ?? "";
  return { command, stdout: unescapeXml(stdout), stderr: unescapeXml(stderr) };
}

// resultMeta for the transcript echo: the payload-driven tool gutter renders
// the command output from this, exactly like a Bash tool result.
export function bashRunResultMeta(run: BashInputRun): ToolResultMeta {
  return {
    kind: "bash",
    status: "completed",
    exit_code: run.exitCode,
    stdout: run.stdout,
    stderr: run.stderr,
  };
}
