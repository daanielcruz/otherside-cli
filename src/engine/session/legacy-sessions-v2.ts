import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { lineToRecord } from "@/engine/session/record/index.ts";
import { configRoot, projectPath } from "@/kernel/std/fs/paths.ts";

const ORPHAN_SLUG = "_orphan";
const MIGRATION_FLAG = ".migrated-sessions-v2";

export function migrateLegacySessions(): { moved: number; orphaned: number } | null {
  const root = configRoot();
  const flag = join(root, MIGRATION_FLAG);
  if (existsSync(flag)) return null;
  const legacy = join(root, "sessions");
  if (!existsSync(legacy)) {
    touchFlag(flag);
    return { moved: 0, orphaned: 0 };
  }
  let names: string[];
  try {
    names = readdirSync(legacy);
  } catch {
    touchFlag(flag);
    return null;
  }
  let moved = 0;
  let orphaned = 0;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const src = join(legacy, name);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(src);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const cwd = extractCwd(src);
    const destDir = cwd === null ? join(root, "projects", ORPHAN_SLUG) : projectPath(cwd);
    mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, name);
    if (existsSync(dest)) continue;
    try {
      renameSync(src, dest);
      if (cwd === null) orphaned += 1;
      else moved += 1;
    } catch {}
  }
  touchFlag(flag);
  return { moved, orphaned };
}

function touchFlag(flag: string): void {
  try {
    mkdirSync(join(flag, ".."), { recursive: true });
    require("node:fs").writeFileSync(flag, new Date().toISOString());
  } catch {}
}

function extractCwd(path: string): string | null {
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split("\n")) {
      const rec = lineToRecord(line);
      if (rec === null) continue;
      if (rec.type === "session_meta" && typeof rec.cwd === "string" && rec.cwd.length > 0) {
        return rec.cwd;
      }
    }
    return null;
  } catch {
    return null;
  }
}
