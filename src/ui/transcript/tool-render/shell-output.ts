import { wrapShellOutput } from "@/ui/transcript/tool-render/format.ts";
import type { ToolPayload } from "@/ui/transcript/tool-render/types.ts";

export const SANDBOX_VIOLATIONS_BLOCK_PATTERN =
  /\n?<sandbox_violations>[\s\S]*?<\/sandbox_violations>\n?/g;

const CWD_RESET_PATTERN = /(?:^|\n)(Shell cwd was reset to [^\n]*)$/;

export type BashPayload = Extract<ToolPayload, { kind: "bash" }>;

export interface BashPayloadPresentation {
  isNoOutput: boolean;
  isDoneLabel: boolean;
  cleanStderr: string;
  cleanStderrWithoutCwdReset: string;
  cwdResetText: string | null;
  bothStreamsEmpty: boolean;
}

export function removeSandboxViolationsBlock(output: string): string {
  return output.replace(SANDBOX_VIOLATIONS_BLOCK_PATTERN, "");
}

export function prepareBashPayload(payload: BashPayload): BashPayloadPresentation {
  const isNoOutput = payload.stdout === "(No output)";
  const isDoneLabel = payload.noOutputExpected === true && payload.stdout === "Done";
  const cleanStderr = removeSandboxViolationsBlock(payload.stderr);
  const cleanStderrWithoutCwdReset = cleanStderr.replace(CWD_RESET_PATTERN, "");
  const cwdResetMatch = cleanStderr.match(CWD_RESET_PATTERN);
  return {
    isNoOutput,
    isDoneLabel,
    cleanStderr,
    cleanStderrWithoutCwdReset,
    cwdResetText: cwdResetMatch ? (cwdResetMatch[1] ?? null) : null,
    bothStreamsEmpty:
      (payload.stdout.length === 0 || isNoOutput || isDoneLabel) &&
      cleanStderrWithoutCwdReset.trim().length === 0,
  };
}

export interface BashOutputRow {
  text: string;
  tone: "error" | "body" | "muted" | "warning";
  /** True when the row opens a block of its own instead of continuing the output. */
  startsBlock?: boolean;
}

export function bashOutputRows(
  payload: BashPayload,
  columns: number,
  isError: boolean,
): BashOutputRow[] {
  const presentation = prepareBashPayload(payload);
  return isError
    ? bashErrorRows(payload, presentation, columns)
    : bashSuccessRows(payload, presentation, columns);
}

function bashErrorRows(
  payload: BashPayload,
  presentation: BashPayloadPresentation,
  columns: number,
): BashOutputRow[] {
  const rows: BashOutputRow[] = [];
  if (payload.exitCode > 0 && presentation.bothStreamsEmpty) {
    rows.push({ text: `Error: Exit code ${payload.exitCode}`, tone: "error" });
  }
  const stdoutLines =
    presentation.isNoOutput || presentation.isDoneLabel
      ? [payload.stdout]
      : wrapShellOutput(payload.stdout, columns);
  if (payload.stdout.length > 0) {
    for (const raw of stdoutLines) rows.push({ text: raw, tone: "error" });
  }
  if (payload.stderr.length > 0) {
    for (const raw of wrapShellOutput(payload.stderr, columns)) {
      rows.push({ text: raw, tone: "error" });
    }
  }
  return rows;
}

function bashSuccessRows(
  payload: BashPayload,
  presentation: BashPayloadPresentation,
  columns: number,
): BashOutputRow[] {
  const rows: BashOutputRow[] = [];
  const stdoutLines =
    presentation.isNoOutput || presentation.isDoneLabel
      ? [payload.stdout]
      : wrapShellOutput(payload.stdout, columns);
  if (payload.stdout.length > 0) {
    const tone: BashOutputRow["tone"] =
      presentation.isNoOutput || presentation.isDoneLabel ? "muted" : "body";
    for (const raw of stdoutLines) rows.push({ text: raw, tone });
  }
  const stderrBody = presentation.cwdResetText
    ? presentation.cleanStderrWithoutCwdReset.trim()
    : presentation.cleanStderr;
  if (stderrBody.length > 0) {
    for (const raw of wrapShellOutput(stderrBody, columns)) {
      const isSandboxLine = raw.startsWith("[sandbox]") || raw.startsWith("  - ");
      rows.push({ text: raw, tone: isSandboxLine ? "warning" : "body" });
    }
  }
  if (payload.exitCode > 0 && presentation.bothStreamsEmpty) {
    const exitText = payload.returnCodeInterpretation
      ? `Exit code ${payload.exitCode} · ${payload.returnCodeInterpretation}`
      : `Exit code ${payload.exitCode}`;
    rows.push({ text: exitText, tone: "error" });
  }
  // The reset is a statement about the shell, not a line of the command's output,
  // so it opens its own block wherever the surrounding rows leave it.
  if (presentation.cwdResetText) {
    rows.push({ text: presentation.cwdResetText, tone: "muted", startsBlock: true });
  }
  return rows;
}
