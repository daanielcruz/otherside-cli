import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

export function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" || process.platform === "darwin"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function pathInside(path: string, root: string): boolean {
  if (samePath(path, root)) return true;
  const candidate = resolve(path);
  const parent = resolve(root);
  return process.platform === "win32" || process.platform === "darwin"
    ? candidate.toLowerCase().startsWith(`${parent.toLowerCase()}${sep}`)
    : candidate.startsWith(`${parent}${sep}`);
}

export function isNetworkWorktreePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    normalized.startsWith("//") ||
    normalized === "/net" ||
    normalized.startsWith("/net/") ||
    normalized === "/Network" ||
    normalized.startsWith("/Network/")
  );
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
