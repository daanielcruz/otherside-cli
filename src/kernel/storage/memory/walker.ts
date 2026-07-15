import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, normalize, relative, resolve, sep } from "node:path";

const MAX_MEMORY_FILE_BYTES = 256 * 1024;

export function canonicalize(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return normalize(path);
  }
}

export function isContainedWithin(candidate: string, root: string): boolean {
  const rootReal = canonicalize(root);
  const candidateReal = canonicalize(candidate);
  if (candidateReal === rootReal) return true;
  const rel = relative(rootReal, candidateReal);
  return (
    rel.length > 0 &&
    !rel.startsWith("..") &&
    !rel.startsWith(`..${sep}`) &&
    !rel.includes(`${sep}..${sep}`)
  );
}

export function canonicalizeDir(path: string): string {
  let cur = normalize(path);
  const tail: string[] = [];
  while (cur !== dirname(cur)) {
    try {
      const real = realpathSync(cur);
      return tail.length === 0 ? real : resolve(real, ...tail.reverse());
    } catch {
      tail.push(cur.split("/").pop() ?? "");
      cur = dirname(cur);
    }
  }
  return normalize(path);
}

export function readFileSafe(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const st = statSync(path);
    if (!st.isFile()) return null;
    if (st.size > MAX_MEMORY_FILE_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function readMemoryFile(options: { path: string; root: string }): string | null {
  const { path, root } = options;
  try {
    const link = lstatSync(path);
    if (link.isSymbolicLink()) return null;
    if (!isContainedWithin(path, root)) return null;
    return readFileSafe(path);
  } catch {
    return null;
  }
}

export function walkAncestors(start: string): string[] {
  const dirs: string[] = [];
  let cur = resolve(start);
  while (true) {
    dirs.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs.reverse();
}
