import { stringWidth } from "@/terminal-runtime/text/cell-width.js";

const cache = new Map<string, number>();

const MAX_CACHE_SIZE = 4096;

export function lineWidth(line: string): number {
  const cached = cache.get(line);
  if (cached !== undefined) return cached;

  const width = stringWidth(line);

  if (cache.size >= MAX_CACHE_SIZE) {
    cache.clear();
  }

  cache.set(line, width);
  return width;
}
