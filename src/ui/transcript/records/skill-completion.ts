export interface SkillCompletionSummary {
  skillName: string | undefined;
  output: string;
  isError: boolean;
}

const REPORT_RE = /Report:\s*(\/[^\s\n)]+)/;
const SUMMARY_RE =
  /(\d+)\s*critical\s*[·,]\s*(\d+)\s*high\s*[·,]\s*(\d+)\s*medium\s*[·,]\s*(\d+)\s*low(?:\s*[·,]\s*(\d+)\s*info)?/i;

export function buildSkillCompletionSummary(
  skillName: string | undefined,
  output: string,
  isError: boolean,
): string | null {
  if (isError && output.length === 0) return null;
  const reportMatch = output.match(REPORT_RE);
  const reportPath = reportMatch ? reportMatch[1] : null;
  const summaryMatch = output.match(SUMMARY_RE);
  const counts = summaryMatch ? formatCounts(summaryMatch) : null;
  if (isError && !reportPath && !counts) {
    const head = skillName ? `Failed · ${skillName}` : "Failed";
    return `${head} · ${errorLine(output)}`;
  }
  if (!reportPath && !counts) return null;
  const head = skillName ? `Done · ${skillName}` : "Done";
  const parts = [head];
  if (counts) parts.push(counts);
  if (reportPath) parts.push(`Report: ${reportPath}`);
  return parts.join(" · ");
}

function errorLine(output: string): string {
  const first =
    output
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "failed";
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}

function formatCounts(m: RegExpMatchArray): string {
  const critical = Number.parseInt(m[1] ?? "0", 10);
  const high = Number.parseInt(m[2] ?? "0", 10);
  const medium = Number.parseInt(m[3] ?? "0", 10);
  const low = Number.parseInt(m[4] ?? "0", 10);
  const infoRaw = m[5];
  const info = infoRaw === undefined ? null : Number.parseInt(infoRaw, 10);
  const fields = [`${critical} critical`, `${high} high`, `${medium} medium`, `${low} low`];
  if (info !== null) fields.push(`${info} info`);
  return fields.join(" · ");
}
