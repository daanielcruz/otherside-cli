import type { SlashKind } from "@/commands/index.ts";
import { lookup as slashLookup } from "@/commands/index.ts";

const IMMEDIATE_SLASH_KINDS = new Set<SlashKind>(["panel", "auth"]);
// Commands that mutate broker/session state and must reach handleSlash mid-turn
// (not sit as a [QUEUED] message that only applies at turn end). `goal` pushes
// its meta message onto the running turn's injection queue; `fast`/`effort`/
// `model` re-read broker state on the next request, so applying immediately is
// safe and matches the behavior of the same change via /config. Ultracode is
// reached via `/effort ultracode` (the `effort` entry covers it). `clear` is
// intentionally NOT here: it must queue to avoid miss-send.
const IMMEDIATE_SLASH_NAMES = new Set([
  "exit",
  "quit",
  "btw",
  "sidequest",
  "fork",
  "goal",
  "fast",
  "effort",
  "model",
]);

export function isImmediateSlash(rawText: string): boolean {
  const text = rawText.trim();
  if (!text.startsWith("/")) return false;
  const name = text.slice(1).trim().split(/\s+/)[0] ?? "";
  if (name === "") return false;
  const cmd = slashLookup(name);
  if (!cmd) return false;
  return IMMEDIATE_SLASH_KINDS.has(cmd.kind) || IMMEDIATE_SLASH_NAMES.has(cmd.name);
}
