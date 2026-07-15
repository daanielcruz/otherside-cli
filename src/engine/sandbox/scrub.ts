import { existsSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const BARE_REPO_FILES = ["HEAD", "packed-refs", "description"] as const;
const BARE_REPO_DIRS = ["objects", "refs", "hooks", "info", "branches"] as const;

export function scrubBareGitRepoFiles(cwd: string, commandStartTimeMs: number): string[] {
  if (existsSync(join(cwd, ".git"))) return [];
  const removed: string[] = [];
  for (const name of [...BARE_REPO_FILES, ...BARE_REPO_DIRS]) {
    const fp = join(cwd, name);
    let info: ReturnType<typeof statSync>;
    try {
      info = statSync(fp);
    } catch {
      continue;
    }
    if (info.mtimeMs < Math.floor(commandStartTimeMs / 1000) * 1000) continue;
    try {
      if (info.isDirectory()) {
        rmSync(fp, { recursive: true, force: true });
      } else {
        unlinkSync(fp);
      }
      removed.push(name);
    } catch {}
  }
  return removed;
}
