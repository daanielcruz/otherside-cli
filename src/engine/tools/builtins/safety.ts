import { splitCommandParts } from "@/engine/tools/_infra/command-analysis/commands.ts";

const DISALLOWED_AUTO_BG_COMMANDS = new Set(["sleep"]);

function invokesGit(command: string): boolean {
  if (command === "git" || command.startsWith("git ")) return true;
  return splitCommandParts(command).some((part) => {
    const tokens = part.trim().split(/\s+/);
    const first = tokens[0]?.split("/").pop();
    return first === "git" || (first === "xargs" && tokens.includes("git"));
  });
}

const SEARCH_OR_READ_PATTERNS: RegExp[] = [
  /^(find|grep|rg|ag|fd|fdfind)\b/,
  /^ls\b/,
  /^(cat|head|tail|wc|nl|less|more)\b/,
];

function trimmedHead(command: string): string {
  return command
    .trim()
    .replace(/^[A-Z_]+=\S+\s+/, "")
    .replace(/^timeout\s+\S+\s+/, "");
}

export function isReadOrSearchCommand(command: string): boolean {
  const head = trimmedHead(command);
  if (head.includes("&&") || head.includes(";") || head.includes("|")) return false;
  return SEARCH_OR_READ_PATTERNS.some((re) => re.test(head));
}

export function countNonEmptyLines(s: string): number {
  if (!s) return 0;
  let count = 0;
  for (const line of s.split("\n")) {
    if (line.length > 0) count++;
  }
  return count;
}

export function isAutoBackgroundableCommand(command: string): boolean {
  if (invokesGit(command)) return false;
  const head = trimmedHead(command);
  if (head.includes("&&") || head.includes(";") || head.includes("|")) return false;
  const baseCommand = head.split(/\s+/)[0] ?? "";
  return !DISALLOWED_AUTO_BG_COMMANDS.has(baseCommand);
}
