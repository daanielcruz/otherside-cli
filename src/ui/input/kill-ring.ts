// Kill ring shared by every prompt instance: killed (cut) text accumulates
// while consecutive kills run, Ctrl+Y yanks the newest entry, and Alt+Y
// cycles older entries immediately after a yank.

const RING_CAPACITY = 10;

let ring: string[] = [];
let ringCursor = 0;
let chainActive = false;

let yankStart = 0;
let yankLength = 0;
let yankActive = false;

export function recordKill(text: string, direction: "prepend" | "append"): void {
  if (text.length === 0) return;
  if (chainActive && ring.length > 0) {
    ring[0] = direction === "prepend" ? text + ring[0] : ring[0] + text;
  } else {
    ring.unshift(text);
    if (ring.length > RING_CAPACITY) ring.pop();
  }
  chainActive = true;
  yankActive = false;
}

export function latestKill(): string {
  return ring[0] ?? "";
}

// Any key that is neither a kill nor a yank breaks both chains.
export function interruptKillChain(): void {
  chainActive = false;
  yankActive = false;
}

export function beginYank(start: number, length: number): void {
  yankStart = start;
  yankLength = length;
  yankActive = true;
  ringCursor = 0;
}

// Cycle to the next ring entry, reporting the span the previous yank wrote so
// the caller can replace it. Returns null unless the last action was a yank
// and an older entry exists.
export function nextYankPop(): { text: string; start: number; length: number } | null {
  if (!yankActive || ring.length <= 1) return null;
  ringCursor = (ringCursor + 1) % ring.length;
  const text = ring[ringCursor] ?? "";
  const replaced = { text, start: yankStart, length: yankLength };
  yankLength = text.length;
  return replaced;
}

export function resetKillRing(): void {
  ring = [];
  ringCursor = 0;
  chainActive = false;
  yankActive = false;
  yankStart = 0;
  yankLength = 0;
}
