export const OUTPUT_CAP = 30_000;
export const OUTPUT_CAP_UPPER_LIMIT = 150_000;

// `BASH_MAX_OUTPUT_LENGTH` raises the truncation ceiling; it is opt-in and leaves the default unchanged. Large output beyond the persist threshold still offloads to disk for memory hygiene rather than staying fully inline.
export function bashOutputCap(): number {
  const raw = process.env.BASH_MAX_OUTPUT_LENGTH;
  if (!raw) return OUTPUT_CAP;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, OUTPUT_CAP_UPPER_LIMIT)
    : OUTPUT_CAP;
}

export function truncationMarker(remainingLines: number): string {
  return `\n\n... [${remainingLines} lines truncated] ...`;
}

export interface CombinedCap {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

const TRUNCATED_OUTPUT_SUFFIX = /\n\n\.\.\. \[\d+ lines truncated\] \.\.\.$/;

export function capHeadCombined(stdout: string, stderr: string): CombinedCap {
  const cap = bashOutputCap();
  const stdoutAlreadyTruncated = TRUNCATED_OUTPUT_SUFFIX.test(stdout);

  const stdoutSlice = stdoutAlreadyTruncated ? stdout : stdout.slice(0, cap * 2);
  const outChars = Array.from(stdoutSlice);
  const stdoutTruncated =
    stdoutAlreadyTruncated || stdout.length > stdoutSlice.length || outChars.length > cap;
  const cappedStdout = stdoutAlreadyTruncated
    ? stdout
    : stdoutTruncated
      ? outChars.slice(0, cap).join("")
      : stdout;

  const remaining = Math.max(0, cap - Math.min(outChars.length, cap));

  const stderrSlice = stderr.slice(0, remaining * 2);
  const errChars = Array.from(stderrSlice);
  const stderrTruncated = stderr.length > stderrSlice.length || errChars.length > remaining;
  const cappedStderr = stderrTruncated ? errChars.slice(0, remaining).join("") : stderr;

  return { stdout: cappedStdout, stderr: cappedStderr, stdoutTruncated, stderrTruncated };
}

export function trimLeadingBlankLines(s: string): string {
  const lines = s.split("\n");
  let i = 0;
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
  return lines.slice(i).join("\n");
}

export function mergeStdoutStderr(stdout: string, stderr: string): string {
  const processedStdout = trimLeadingBlankLines(stdout).replace(/\s+$/, "");
  const stderrTrimmed = stderr.trim();
  if (processedStdout && stderrTrimmed) return `${processedStdout}\n${stderrTrimmed}`;
  if (processedStdout) return processedStdout;
  if (stderrTrimmed) return stderrTrimmed;
  return "";
}

export function appendExitCodeNote(text: string, note: string): string {
  if (note === "") return text;
  return text.length > 0 ? `${text}\n${note}` : note;
}
