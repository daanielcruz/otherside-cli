import { writeSync } from "node:fs";
import { loadConfigSync } from "@/kernel/config/config.ts";
import { env } from "@/kernel/std/proc/env.ts";

const SUPPORTED_TERMINALS = new Set(["iTerm.app", "WezTerm", "vscode"]);

export type TerminalProgressState = "indeterminate" | "completed" | "error";
export type TerminalProgressSequenceBuilder = (state: TerminalProgressState) => string;

let buildSequence: TerminalProgressSequenceBuilder | null = null;

export function setTerminalProgressSequenceBuilder(build: TerminalProgressSequenceBuilder): void {
  buildSequence = build;
}

export function isTerminalProgressSupported(): boolean {
  return SUPPORTED_TERMINALS.has(env.terminal ?? "");
}

function isEnabled(): boolean {
  return loadConfigSync().terminalProgressBarEnabled ?? true;
}

export function emitTerminalProgress(state: TerminalProgressState): void {
  if (!buildSequence || !isEnabled() || !isTerminalProgressSupported()) return;
  writeSync(1, buildSequence(state));
}
