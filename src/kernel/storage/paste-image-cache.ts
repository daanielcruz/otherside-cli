import { Buffer } from "node:buffer";
import { readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { imageCacheRoot } from "@/kernel/std/fs/paths.ts";
import { mkdirSecure, writeFileSecure } from "@/kernel/std/fs/secure-fs.ts";
import type { ImageMediaType } from "@/kernel/std/types/image.ts";

const STALE_CACHE_AGE_MS = 24 * 60 * 60 * 1000;

function imageCacheDirFor(sessionId: string): string {
  return join(imageCacheRoot(), sessionId);
}

export function persistPastedImage(params: {
  sessionId: string;
  id: number;
  base64: string;
  mediaType: ImageMediaType;
}): string | null {
  const { sessionId, id, base64, mediaType } = params;
  try {
    const dir = imageCacheDirFor(sessionId);
    mkdirSecure(dir, 0o700);
    const ext = mediaType === "image/jpeg" ? "jpg" : (mediaType.split("/")[1] ?? "png");
    const path = join(dir, `${id}.${ext}`);
    writeFileSecure(path, Buffer.from(base64, "base64"), 0o600);
    return path;
  } catch {
    return null;
  }
}

export function cleanupStaleImageCaches(
  currentSessionId: string,
  isSessionAlive: (sessionId: string) => boolean,
): void {
  const root = imageCacheRoot();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (name === currentSessionId) continue;
    if (isSessionAlive(name)) continue;
    const path = join(root, name);
    let ageMs = 0;
    try {
      ageMs = now - statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (ageMs < STALE_CACHE_AGE_MS) continue;
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {}
  }
  try {
    const remaining = readdirSync(root);
    if (remaining.length === 0) rmdirSync(root);
  } catch {}
}
