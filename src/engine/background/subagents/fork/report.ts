import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const REPORT_PATH_IN_BODY_RE = /`((?:\/|[A-Za-z]:[\\/])[^`\n]*[\\/]reports[\\/][^`\n]+\.md)`/;

export function reportPathFromBody(body: string): string | null {
  const match = body.match(REPORT_PATH_IN_BODY_RE);
  return match ? (match[1] ?? null) : null;
}

export function withGuaranteedReport(body: string, output: string): string {
  const reportPath = reportPathFromBody(body);
  if (!reportPath) return output;
  if (!existsSync(reportPath)) {
    try {
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, output, "utf8");
    } catch {
      return output;
    }
  }
  return output.includes(reportPath) ? output : `${output}\n\nReport: ${reportPath}`;
}
