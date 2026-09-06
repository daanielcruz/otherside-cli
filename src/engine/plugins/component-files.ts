import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ResolvedSkill } from "./loader.ts";

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function isWithinRoot(root: string, target: string): boolean {
  const relativeTarget = relative(canonicalPath(root), canonicalPath(target));
  return (
    relativeTarget === "" ||
    (relativeTarget !== ".." &&
      !relativeTarget.startsWith(`..${sep}`) &&
      !isAbsolute(relativeTarget))
  );
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function existsAt(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

export function readJsonFile(p: string): unknown {
  const raw = readFileSync(p, "utf8");
  return JSON.parse(raw);
}

export function collectMdFiles(
  dir: string,
  root: string,
): { name: string; path: string; content: string }[] {
  if (!isDirectory(dir)) return [];
  const results: { name: string; path: string; content: string }[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(dir, entry);
    if (!isWithinRoot(root, filePath)) continue;
    if (!isFile(filePath)) continue;
    try {
      const content = readFileSync(filePath, "utf8");
      const name = entry.replace(/\.md$/, "");
      results.push({ name, path: filePath, content });
    } catch {}
  }
  return results;
}

export function collectMdPath(
  path: string,
  root: string,
): { name: string; path: string; content: string }[] {
  const target = resolve(root, path);
  if (!isWithinRoot(root, target)) return [];
  if (isDirectory(target)) return collectMdFiles(target, root);
  if (!isFile(target) || extname(target).toLowerCase() !== ".md") return [];
  try {
    return [
      {
        name: basename(target, extname(target)),
        path: target,
        content: readFileSync(target, "utf8"),
      },
    ];
  } catch {
    return [];
  }
}

export function collectSkillEntries(dir: string, root: string): ResolvedSkill[] {
  if (!isDirectory(dir)) return [];
  const results: ResolvedSkill[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry);
    if (!isWithinRoot(root, entryPath)) continue;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(entryPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const skillFile = join(entryPath, "SKILL.md");
      if (!isWithinRoot(root, skillFile)) continue;
      try {
        const content = readFileSync(skillFile, "utf8");
        results.push({ name: entry, path: skillFile, content });
      } catch {}
    } else if (stat.isFile() && entry.endsWith(".md")) {
      try {
        const content = readFileSync(entryPath, "utf8");
        results.push({ name: entry.replace(/\.md$/, ""), path: entryPath, content });
      } catch {}
    }
  }
  return results;
}

export function collectSkillPath(path: string, root: string): ResolvedSkill[] {
  const target = resolve(root, path);
  if (!isWithinRoot(root, target)) return [];
  if (isDirectory(target)) {
    const skillFile = join(target, "SKILL.md");
    if (isFile(skillFile)) {
      try {
        return [
          { name: basename(target), path: skillFile, content: readFileSync(skillFile, "utf8") },
        ];
      } catch {
        return [];
      }
    }
    return collectSkillEntries(target, root);
  }
  return collectMdPath(target, root).map((entry) => ({
    name: entry.name,
    path: entry.path,
    content: entry.content,
  }));
}
