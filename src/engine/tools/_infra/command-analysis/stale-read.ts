import { stat } from "node:fs/promises";
import { relative } from "node:path/posix";

const WRITE_COMMAND_MARKERS = new RegExp(
  [
    "--write",
    "--fix",
    "--in-place",
    "--auto-correct",
    "\\brun\\s+format\\b",
    "\\brun\\s+fix\\b",
    "\\b(yarn|pnpm)\\s+format\\b",
    "\\blint:file\\b",
    "\\blint:fix\\b",
    "\\bblack\\b",
    "\\bisort\\b",
    "\\bruff\\s+format\\b",
    "\\bcargo\\s+(fmt|fix)\\b",
    "\\brustfmt\\b",
    "\\bgo\\s+fmt\\b",
    "\\bterraform\\s+fmt\\b",
    "\\bdprint\\s+fmt\\b",
    "\\bswiftformat\\b",
    "\\bphpcbf\\b",
  ].join("|"),
);

const MAX_LISTED_FILES = 5;

interface StaleReadInput {
  command: string;
  entries: { path: string; mtime: number }[];
  startTimeMs: number;
  cwd: string;
}

export async function maybeBuildStaleReadHint(input: StaleReadInput): Promise<string | undefined> {
  const { command, entries, startTimeMs, cwd } = input;
  if (!WRITE_COMMAND_MARKERS.test(command)) return undefined;
  const modified: string[] = [];
  await Promise.all(
    entries.map(async ({ path, mtime }) => {
      try {
        const stats = await stat(path);
        if (stats.mtimeMs > startTimeMs && stats.mtimeMs > mtime) modified.push(path);
      } catch {}
    }),
  );
  if (modified.length === 0) return undefined;
  const shown = modified
    .slice(0, MAX_LISTED_FILES)
    .map((filePath) => displayPath(filePath, cwd))
    .join(", ");
  const more =
    modified.length > MAX_LISTED_FILES ? ` and ${modified.length - MAX_LISTED_FILES} more` : "";
  const noun = modified.length === 1 ? "file" : "files";
  return `[This command modified ${modified.length} ${noun} you've previously read: ${shown}${more}. Call Read before editing.]`;
}

function displayPath(filePath: string, cwd: string): string {
  const rel = relative(cwd, filePath);
  return rel.length > 0 ? rel : filePath;
}
